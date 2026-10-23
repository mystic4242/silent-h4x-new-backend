BEGIN;

CREATE TABLE IF NOT EXISTS customers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    display_name VARCHAR(80),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'banned')),
    referred_by BIGINT REFERENCES customers(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_access_keys (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix VARCHAR(16) NOT NULL,
    label VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_keys_customer
    ON customer_access_keys(customer_id);

CREATE TABLE IF NOT EXISTS wallets (
    customer_id BIGINT PRIMARY KEY REFERENCES customers(id),
    balance NUMERIC(14,2) NOT NULL DEFAULT 0
        CHECK (balance >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    transaction_type VARCHAR(20) NOT NULL
        CHECK (transaction_type IN (
            'topup', 'purchase', 'refund', 'adjustment'
        )),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    direction VARCHAR(10) NOT NULL
        CHECK (direction IN ('credit', 'debit')),
    reference VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_by_admin BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_customer
    ON wallet_transactions(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    payment_reference VARCHAR(100) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    customer_note TEXT,
    admin_note TEXT,
    reviewed_by BIGINT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_status
    ON payment_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS products (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slot INTEGER NOT NULL UNIQUE CHECK (slot >= 1),
    name VARCHAR(120) NOT NULL,
    image_url TEXT,
    product_url TEXT,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'inactive'
        CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_durations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id),
    duration_hours INTEGER NOT NULL
        CHECK (duration_hours IN (2, 48, 168, 720)),
    price NUMERIC(14,2) NOT NULL CHECK (price >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (product_id, duration_hours)
);

CREATE TABLE IF NOT EXISTS orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    product_id BIGINT NOT NULL REFERENCES products(id),
    duration_hours INTEGER NOT NULL
        CHECK (duration_hours IN (2, 48, 168, 720)),
    price_paid NUMERIC(14,2) NOT NULL CHECK (price_paid >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'completed'
        CHECK (status IN ('completed', 'cancelled', 'refunded')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer
    ON orders(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generated_keys (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id),
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    product_id BIGINT NOT NULL REFERENCES products(id),
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'revoked')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generated_keys_customer
    ON generated_keys(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username VARCHAR(80) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    admin_id BIGINT REFERENCES admin_users(id),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(80),
    entity_id VARCHAR(100),
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_profiles (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL UNIQUE REFERENCES customers(id),
    referral_code VARCHAR(32) NOT NULL UNIQUE,
    display_name VARCHAR(80),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    referral_profile_id BIGINT NOT NULL
        REFERENCES referral_profiles(id),
    event_type VARCHAR(30) NOT NULL
        CHECK (event_type IN (
            'visit', 'whatsapp_click', 'conversion'
        )),
    visitor_token_hash TEXT,
    landing_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_events_profile
    ON referral_events(referral_profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS referral_attributions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    referral_profile_id BIGINT NOT NULL
        REFERENCES referral_profiles(id),
    referred_customer_id BIGINT NOT NULL UNIQUE
        REFERENCES customers(id),
    first_visit_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attribution_expires_at TIMESTAMPTZ NOT NULL
        DEFAULT (NOW() + INTERVAL '30 days'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_attributions_profile
    ON referral_attributions(referral_profile_id, created_at DESC);

COMMIT;
