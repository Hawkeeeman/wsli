#!/usr/bin/env python3
"""Strict Discord trading bot with hard risk controls."""
import asyncio
import json
import os
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import discord
import pandas as pd
import yfinance as yf
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import GetOrdersRequest, MarketOrderRequest
from discord import app_commands
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
SECRET_PATH = ROOT / '.env.secret'
CONFIG_PATH = ROOT / 'strict_config.json'

if SECRET_PATH.exists():
    load_dotenv(SECRET_PATH, override=True)


@dataclass
class RiskConfig:
    allowed_symbols: List[str]
    max_notional_per_trade: float
    max_open_positions: int
    daily_max_loss_usd: float
    min_confidence_to_trade: float
    cooldown_minutes_per_symbol: int
    poll_interval_minutes: int


@dataclass
class StrategyConfig:
    fast_sma: int
    slow_sma: int
    rsi_period: int
    rsi_buy_below: float
    rsi_sell_above: float
    min_price: float
    min_dollar_volume: float


class StrictTradingBot:
    def __init__(self) -> None:
        mode = (os.getenv('ALPACA_TRADING_MODE') or '').strip().lower()
        if mode not in {'paper', 'live'}:
            raise SystemExit('Set ALPACA_TRADING_MODE to "paper" or "live" in .env.secret.')
        self.mode = mode
        self.alert_channel_id = self._read_alert_channel_id()

        key = (os.getenv('ALPACA_KEY_ID') or os.getenv('ALPACA_API_KEY') or '').strip()
        secret = (os.getenv('ALPACA_SECRET_KEY') or os.getenv('ALPACA_API_SECRET') or '').strip()
        self.discord_token = (os.getenv('DISCORD_BOT_TOKEN') or '').strip()
        if not key or not secret or not self.discord_token:
            raise SystemExit('Missing ALPACA_KEY_ID/ALPACA_SECRET_KEY/DISCORD_BOT_TOKEN in .env.secret.')

        self.trading_client = TradingClient(key, secret, paper=(self.mode == 'paper'))
        self.risk_cfg, self.strategy_cfg = self._load_config()

        self.discord_client = discord.Client(intents=discord.Intents.default())
        self.tree = app_commands.CommandTree(self.discord_client)

        self.autopilot_enabled = False
        self.last_trade_ts: Dict[str, datetime] = {}
        self.session_start_equity: Optional[float] = None
        self.session_start_ts = datetime.now(timezone.utc)
        self.day_start_equity: Optional[float] = None
        self.day_start_date: Optional[date] = None

        self._register_commands()

    @staticmethod
    def _read_alert_channel_id() -> int:
        raw = (os.getenv("DISCORD_ALERT_CHANNEL_ID") or "").strip()
        if not raw:
            raise SystemExit('Set DISCORD_ALERT_CHANNEL_ID in .env.secret (channel to post trade notifications).')
        try:
            return int(raw)
        except ValueError as e:
            raise SystemExit("DISCORD_ALERT_CHANNEL_ID must be an integer channel ID.") from e

    def _load_config(self) -> Tuple[RiskConfig, StrategyConfig]:
        if not CONFIG_PATH.exists():
            raise SystemExit('strict_config.json not found. Copy strict_config.example.json to strict_config.json.')
        with CONFIG_PATH.open('r', encoding='utf-8') as f:
            cfg = json.load(f)

        risk = cfg.get('risk') or {}
        strategy = cfg.get('strategy') or {}

        allowed = [str(s).upper().strip() for s in (risk.get('allowed_symbols') or []) if str(s).strip()]
        if not allowed:
            raise SystemExit('strict_config.json risk.allowed_symbols must contain at least one symbol.')

        return (
            RiskConfig(
                allowed_symbols=allowed,
                max_notional_per_trade=float(risk['max_notional_per_trade']),
                max_open_positions=int(risk['max_open_positions']),
                daily_max_loss_usd=float(risk['daily_max_loss_usd']),
                min_confidence_to_trade=float(risk['min_confidence_to_trade']),
                cooldown_minutes_per_symbol=int(risk['cooldown_minutes_per_symbol']),
                poll_interval_minutes=max(1, int(risk['poll_interval_minutes'])),
            ),
            StrategyConfig(
                fast_sma=int(strategy['fast_sma']),
                slow_sma=int(strategy['slow_sma']),
                rsi_period=int(strategy['rsi_period']),
                rsi_buy_below=float(strategy['rsi_buy_below']),
                rsi_sell_above=float(strategy['rsi_sell_above']),
                min_price=float(strategy['min_price']),
                min_dollar_volume=float(strategy['min_dollar_volume']),
            ),
        )

    @staticmethod
    def _fmt_money(v: Optional[float]) -> str:
        if v is None:
            return '-'
        return f'${float(v):,.2f}'

    def _rsi(self, closes: pd.Series, period: int) -> float:
        delta = closes.diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.rolling(period).mean()
        avg_loss = loss.rolling(period).mean()
        rs = avg_gain / avg_loss.replace(0, pd.NA)
        rsi = 100 - (100 / (1 + rs))
        value = rsi.iloc[-1]
        return float(value) if pd.notna(value) else 50.0

    def _research_symbol(self, symbol: str) -> dict:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period='6mo', interval='1d', auto_adjust=False)
        if hist.empty or len(hist) < max(self.strategy_cfg.slow_sma + 5, self.strategy_cfg.rsi_period + 5):
            raise ValueError(f'Not enough data for {symbol}.')

        close = hist['Close']
        volume = hist['Volume']
        fast = float(close.rolling(self.strategy_cfg.fast_sma).mean().iloc[-1])
        slow = float(close.rolling(self.strategy_cfg.slow_sma).mean().iloc[-1])
        rsi = self._rsi(close, self.strategy_cfg.rsi_period)
        price = float(close.iloc[-1])
        dollar_volume_20d = float((close.tail(20) * volume.tail(20)).mean())

        signal = 'hold'
        confidence = 0.0
        reasons: List[str] = []

        if price < self.strategy_cfg.min_price:
            reasons.append('price below minimum')
        if dollar_volume_20d < self.strategy_cfg.min_dollar_volume:
            reasons.append('liquidity below minimum')

        if fast > slow:
            confidence += 40
            reasons.append('trend up (fast SMA > slow SMA)')
        else:
            confidence -= 30
            reasons.append('trend down (fast SMA <= slow SMA)')

        if rsi <= self.strategy_cfg.rsi_buy_below:
            confidence += 35
            reasons.append('RSI in buy zone')
        elif rsi >= self.strategy_cfg.rsi_sell_above:
            confidence -= 35
            reasons.append('RSI in sell zone')

        if not reasons:
            reasons.append('no qualifying signals')

        if confidence >= self.risk_cfg.min_confidence_to_trade and price >= self.strategy_cfg.min_price and dollar_volume_20d >= self.strategy_cfg.min_dollar_volume:
            signal = 'buy'
        elif confidence <= -self.risk_cfg.min_confidence_to_trade:
            signal = 'sell'

        return {
            'symbol': symbol,
            'signal': signal,
            'confidence': round(confidence, 2),
            'price': price,
            'fast_sma': round(fast, 2),
            'slow_sma': round(slow, 2),
            'rsi': round(rsi, 2),
            'dollar_volume_20d': dollar_volume_20d,
            'reasons': reasons,
        }

    def _can_trade_symbol(self, symbol: str) -> Tuple[bool, str]:
        if symbol not in self.risk_cfg.allowed_symbols:
            return False, f'{symbol} is not in allowed_symbols.'

        now = datetime.now(timezone.utc)
        last = self.last_trade_ts.get(symbol)
        if last is not None:
            elapsed_min = (now - last).total_seconds() / 60.0
            if elapsed_min < self.risk_cfg.cooldown_minutes_per_symbol:
                return False, f'{symbol} cooldown active ({elapsed_min:.1f}m elapsed).'

        account = self.trading_client.get_account()
        equity = float(account.equity)
        self._refresh_day_start_equity(equity)
        if self.day_start_equity is None:
            return False, 'Could not establish day start equity.'

        daily_loss = max(0.0, self.day_start_equity - equity)
        if daily_loss >= self.risk_cfg.daily_max_loss_usd:
            return False, f'Daily loss limit hit ({self._fmt_money(daily_loss)}).'

        positions = self.trading_client.get_all_positions()
        if len(positions) >= self.risk_cfg.max_open_positions:
            return False, f'Max open positions reached ({len(positions)}).'

        open_orders = self.trading_client.get_orders(filter=GetOrdersRequest(status=QueryOrderStatus.OPEN))
        for o in open_orders:
            if str(o.symbol).upper() == symbol:
                return False, f'Open order already exists for {symbol}.'

        return True, 'ok'

    def _refresh_day_start_equity(self, equity: float) -> None:
        today = date.today()
        if self.day_start_date != today:
            self.day_start_date = today
            self.day_start_equity = equity

    def _refresh_session_start_equity(self, equity: float) -> None:
        if self.session_start_equity is None:
            self.session_start_equity = equity

    async def _alert(self, message: str) -> None:
        channel = self.discord_client.get_channel(self.alert_channel_id)
        if channel is None:
            channel = await self.discord_client.fetch_channel(self.alert_channel_id)
        await channel.send(message)

    def _submit_notional_buy(self, symbol: str, price: float) -> Tuple[bool, str]:
        notional = self.risk_cfg.max_notional_per_trade
        qty = int(notional // price)
        if qty <= 0:
            return False, f'Max notional {self._fmt_money(notional)} too small for {symbol} at {self._fmt_money(price)}.'

        req = MarketOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.BUY,
            time_in_force=TimeInForce.DAY,
        )
        order = self.trading_client.submit_order(req)
        self.last_trade_ts[symbol] = datetime.now(timezone.utc)
        return True, f'BUY {qty} {symbol} submitted (order {order.id}).'

    async def _run_autopilot_cycle(self) -> str:
        candidates: List[dict] = []
        for symbol in self.risk_cfg.allowed_symbols:
            try:
                rec = self._research_symbol(symbol)
                if rec['signal'] == 'buy':
                    candidates.append(rec)
            except Exception:
                continue

        if not candidates:
            return 'No buy candidates this cycle.'

        best = sorted(candidates, key=lambda x: x['confidence'], reverse=True)[0]
        ok, reason = self._can_trade_symbol(best['symbol'])
        if not ok:
            return f'No trade: {reason}'

        success, msg = self._submit_notional_buy(best['symbol'], float(best['price']))
        return msg if success else f'No trade: {msg}'

    def _register_commands(self) -> None:
        @self.tree.command(name='status', description='Show bot mode and strict risk limits')
        async def status(interaction: discord.Interaction) -> None:
            account = self.trading_client.get_account()
            equity = float(account.equity)
            self._refresh_day_start_equity(equity)
            self._refresh_session_start_equity(equity)
            daily_loss = max(0.0, (self.day_start_equity or equity) - equity)
            await interaction.response.send_message(
                "\n".join([
                    f'Mode: **{self.mode.upper()}**',
                    f'Autopilot: **{"ON" if self.autopilot_enabled else "OFF"}**',
                    f'Notify channel: `{self.alert_channel_id}`',
                    f'Allowed symbols: {", ".join(self.risk_cfg.allowed_symbols)}',
                    f'Max notional/trade: {self._fmt_money(self.risk_cfg.max_notional_per_trade)}',
                    f'Max open positions: {self.risk_cfg.max_open_positions}',
                    f'Daily max loss: {self._fmt_money(self.risk_cfg.daily_max_loss_usd)}',
                    f'Today loss used: {self._fmt_money(daily_loss)}',
                ])
            )

        @self.tree.command(name="performance", description="Show paper performance (equity change)")
        async def performance(interaction: discord.Interaction) -> None:
            account = self.trading_client.get_account()
            equity = float(account.equity)
            self._refresh_day_start_equity(equity)
            self._refresh_session_start_equity(equity)
            day_start = self.day_start_equity or equity
            session_start = self.session_start_equity or equity
            day_pnl = equity - day_start
            session_pnl = equity - session_start
            await interaction.response.send_message(
                "\n".join([
                    f"Mode: **{self.mode.upper()}**",
                    f"Equity now: {self._fmt_money(equity)}",
                    f"Today P/L: {self._fmt_money(day_pnl)}",
                    f"Since bot start ({self.session_start_ts.strftime('%Y-%m-%d %H:%M UTC')}): {self._fmt_money(session_pnl)}",
                ])
            )

        @self.tree.command(name='research', description='Research one symbol with strict model')
        @app_commands.describe(symbol='Ticker symbol')
        async def research(interaction: discord.Interaction, symbol: str) -> None:
            symbol = symbol.upper().strip()
            await interaction.response.defer()
            try:
                rec = self._research_symbol(symbol)
            except Exception as e:
                await interaction.followup.send(f'Research failed: {e}', ephemeral=True)
                return

            await interaction.followup.send(
                "\n".join([
                    f'**{rec["symbol"]}** signal: **{rec["signal"].upper()}**',
                    f'Confidence: {rec["confidence"]}',
                    f'Price: {self._fmt_money(rec["price"])}',
                    f'SMA{self.strategy_cfg.fast_sma}/{self.strategy_cfg.slow_sma}: {rec["fast_sma"]}/{rec["slow_sma"]}',
                    f'RSI{self.strategy_cfg.rsi_period}: {rec["rsi"]}',
                    f'20d dollar volume: {self._fmt_money(rec["dollar_volume_20d"])}',
                    f'Reasons: {"; ".join(rec["reasons"])}',
                ])
            )

        @self.tree.command(name='trade_now', description='Run strict checks and place one trade for symbol')
        @app_commands.describe(symbol='Ticker symbol')
        async def trade_now(interaction: discord.Interaction, symbol: str) -> None:
            symbol = symbol.upper().strip()
            await interaction.response.defer()

            try:
                rec = self._research_symbol(symbol)
            except Exception as e:
                await interaction.followup.send(f'Research failed: {e}', ephemeral=True)
                return

            if rec['signal'] != 'buy' or rec['confidence'] < self.risk_cfg.min_confidence_to_trade:
                await interaction.followup.send(
                    f'No trade. Signal={rec["signal"]}, confidence={rec["confidence"]}, min={self.risk_cfg.min_confidence_to_trade}'
                )
                return

            ok, reason = self._can_trade_symbol(symbol)
            if not ok:
                await interaction.followup.send(f'No trade: {reason}')
                return

            success, msg = self._submit_notional_buy(symbol, float(rec['price']))
            await interaction.followup.send(msg if success else f'No trade: {msg}')
            if success:
                await self._alert(f"TRADE ({self.mode.upper()}): {msg}")

        @self.tree.command(name='autopilot_on', description='Enable strict autopilot loop')
        async def autopilot_on(interaction: discord.Interaction) -> None:
            self.autopilot_enabled = True
            await interaction.response.send_message('Autopilot enabled.')
            await self._alert(f"Autopilot ON ({self.mode.upper()}).")

        @self.tree.command(name='autopilot_off', description='Disable strict autopilot loop')
        async def autopilot_off(interaction: discord.Interaction) -> None:
            self.autopilot_enabled = False
            await interaction.response.send_message('Autopilot disabled.')
            await self._alert(f"Autopilot OFF ({self.mode.upper()}).")

        @self.tree.command(name='autopilot_cycle', description='Run one autopilot cycle immediately')
        async def autopilot_cycle(interaction: discord.Interaction) -> None:
            await interaction.response.defer()
            try:
                result = await self._run_autopilot_cycle()
                await interaction.followup.send(result)
                if result.startswith("BUY "):
                    await self._alert(f"TRADE ({self.mode.upper()}): {result}")
                elif result.startswith("No trade:"):
                    await self._alert(f"AUTOPILOT ({self.mode.upper()}): {result}")
            except Exception as e:
                await interaction.followup.send(f'Cycle failed: {e}', ephemeral=True)

        @self.discord_client.event
        async def on_ready() -> None:
            await self.tree.sync()
            print(f'Strict trading bot ready in {self.mode.upper()} mode.')
            try:
                await self._alert(f"Bot online ({self.mode.upper()}).")
            except Exception as e:
                print(f"[alert] failed: {e}")
            self.discord_client.loop.create_task(self._autopilot_loop())

    async def _autopilot_loop(self) -> None:
        while True:
            try:
                if self.autopilot_enabled:
                    result = await self._run_autopilot_cycle()
                    print(f'[autopilot] {result}')
                    try:
                        if result.startswith("BUY "):
                            await self._alert(f"TRADE ({self.mode.upper()}): {result}")
                        elif result.startswith("No trade:"):
                            await self._alert(f"AUTOPILOT ({self.mode.upper()}): {result}")
                    except Exception as e:
                        print(f"[alert] failed: {e}")
            except Exception as e:
                print(f'[autopilot] error: {e}')
            await asyncio.sleep(self.risk_cfg.poll_interval_minutes * 60)

    def run(self) -> None:
        self.discord_client.run(self.discord_token)


if __name__ == '__main__':
    StrictTradingBot().run()
