# Strict Autonomous Trading Bot Setup

This bot can run in `paper` or `live` mode, but it fails fast if mode/config/secrets are missing.

## 1) Create strict config

```bash
cp strict_config.example.json strict_config.json
```

Edit `strict_config.json` and keep limits conservative.

## 2) Set secrets and mode in `.env.secret`

Add these keys:

```env
ALPACA_TRADING_MODE=paper
ALPACA_KEY_ID=your_key
ALPACA_SECRET_KEY=your_secret
DISCORD_BOT_TOKEN=your_discord_token
DISCORD_ALERT_CHANNEL_ID=your_channel_id
```

For real money, change only:

```env
ALPACA_TRADING_MODE=live
```

Use live Alpaca keys when in live mode.

## 3) Invite bot with slash commands scope

In Discord Developer Portal, use OAuth2 URL generator with scopes:
- `bot`
- `applications.commands`

## 4) Run

```bash
chmod +x run_strict_bot.sh
./run_strict_bot.sh
```

## 5) In Discord

- `/status` -> verify mode and risk limits
- `/research AAPL` -> view signal and confidence
- `/trade_now AAPL` -> run strict checks and place one trade
- `/autopilot_on` -> start periodic cycle
- `/autopilot_off` -> stop periodic cycle

## Live safety checklist

- Keep `max_notional_per_trade` very small at first.
- Keep `daily_max_loss_usd` small.
- Keep short `allowed_symbols` list.
- Test in paper mode first, then switch to live.
