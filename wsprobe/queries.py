"""GraphQL query documents for wsprobe (queries only — no mutations)."""

FETCH_IDENTITY_PACKAGES = """
query FetchIdentityPackages($id: ID!) {
  identity(id: $id) {
    id
    packages {
      id
      __typename
    }
    __typename
  }
}
"""

FETCH_SECURITY = """
query FetchSecurity($securityId: ID!, $currency: Currency) {
  security(id: $securityId) {
    id
    active
    buyable
    currency
    wsTradeEligible
    wsTradeIneligibilityReason
    status
    securityType
    stock {
      symbol
      name
      primaryExchange
      primaryMic
      __typename
    }
    __typename
  }
}
"""

FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS = """
query FetchSoOrdersLimitOrderRestrictions($args: SoOrders_LimitOrderRestrictionsArgs!) {
  soOrdersLimitOrderRestrictions(args: $args) {
    limitPriceThresholds
    __typename
  }
}
"""
