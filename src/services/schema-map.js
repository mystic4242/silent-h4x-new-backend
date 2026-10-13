module.exports = {
  transactions: {
    type: 'transaction_type',
    direction: 'direction'
  },
  payments: {
    reference: 'payment_reference'
  },
  settings: {
    key: 'setting_key',
    value: 'setting_value'
  },
  durations: {
    active: 'active'
  },
  orders: {
    price: 'price_paid'
  },
  referrals: {
    visitorHash: 'visitor_token_hash',
    path: 'landing_path'
  }
};
