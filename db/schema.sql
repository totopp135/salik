-- =====================================================================
-- e-Toll System - PostgreSQL Schema
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive emails

-- ---------- ENUMS ----------
CREATE TYPE staff_role        AS ENUM ('ADMIN', 'OPERATOR', 'POLICE', 'FINANCE');
CREATE TYPE wallet_txn_type   AS ENUM ('TOPUP', 'TOLL_DEDUCTION', 'REFUND', 'FINE', 'ADJUSTMENT');
CREATE TYPE payment_status    AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED');
CREATE TYPE payment_method    AS ENUM ('VISA', 'FAWRY', 'VODAFONE_CASH', 'OTHER');
CREATE TYPE identify_method   AS ENUM ('ANPR', 'QR', 'RFID', 'MANUAL');
CREATE TYPE passage_status    AS ENUM ('PAID', 'INSUFFICIENT_BALANCE', 'UNREGISTERED',
                                       'STOLEN_ALERT', 'MANUAL_REVIEW', 'WAIVED');
CREATE TYPE violation_status  AS ENUM ('OPEN', 'PAID', 'ESCALATED', 'CANCELLED');
CREATE TYPE alert_status      AS ENUM ('NEW', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE');
CREATE TYPE gate_status       AS ENUM ('ONLINE', 'OFFLINE', 'MAINTENANCE');
CREATE TYPE report_status     AS ENUM ('ACTIVE', 'RECOVERED', 'CANCELLED');

-- ---------- USERS (mobile app customers) ----------
CREATE TABLE users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name      VARCHAR(120) NOT NULL,
    email          CITEXT UNIQUE,
    phone          VARCHAR(20)  NOT NULL UNIQUE,
    national_id    VARCHAR(20)  UNIQUE,
    password_hash  TEXT         NOT NULL,
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    phone_verified BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Push notification tokens (FCM) - a user can have many devices
CREATE TABLE device_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fcm_token  TEXT NOT NULL UNIQUE,
    platform   VARCHAR(10) NOT NULL CHECK (platform IN ('ANDROID','IOS')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- STAFF (web dashboard users) ----------
CREATE TABLE staff_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name     VARCHAR(120) NOT NULL,
    email         CITEXT NOT NULL UNIQUE,
    password_hash TEXT   NOT NULL,
    role          staff_role NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- WALLETS (1:1 with users) ----------
CREATE TABLE wallets (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    currency   CHAR(3) NOT NULL DEFAULT 'EGP',
    low_balance_threshold NUMERIC(12,2) NOT NULL DEFAULT 50,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- VEHICLE TYPES & VEHICLES ----------
CREATE TABLE vehicle_types (
    id    SMALLSERIAL PRIMARY KEY,
    code  VARCHAR(20) NOT NULL UNIQUE,      -- CAR, MICROBUS, BUS, TRUCK, MOTORCYCLE
    name  VARCHAR(50) NOT NULL
);

CREATE TABLE vehicles (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vehicle_type_id  SMALLINT NOT NULL REFERENCES vehicle_types(id),
    plate_number     VARCHAR(20) NOT NULL,        -- normalized (no spaces, Arabic digits -> Latin)
    plate_raw        VARCHAR(30),                 -- as entered by user
    make             VARCHAR(50),
    model            VARCHAR(50),
    color            VARCHAR(30),
    qr_token         VARCHAR(64) UNIQUE,          -- random token encoded in QR
    rfid_tag         VARCHAR(64) UNIQUE,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A plate can only be actively linked to one account at a time
CREATE UNIQUE INDEX uq_vehicles_active_plate ON vehicles(plate_number) WHERE is_active;
CREATE INDEX idx_vehicles_user ON vehicles(user_id);

-- ---------- TOLL GATES & PRICING ----------
CREATE TABLE toll_gates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        VARCHAR(20) NOT NULL UNIQUE,     -- e.g. CAI-ALX-01
    name        VARCHAR(100) NOT NULL,
    highway     VARCHAR(100),
    direction   VARCHAR(30),
    latitude    NUMERIC(9,6),
    longitude   NUMERIC(9,6),
    status      gate_status NOT NULL DEFAULT 'ONLINE',
    api_key_hash TEXT NOT NULL,                  -- gate device authenticates with this
    last_heartbeat TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Price per gate per vehicle type, with validity window (price history preserved)
CREATE TABLE toll_rates (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gate_id          UUID NOT NULL REFERENCES toll_gates(id) ON DELETE CASCADE,
    vehicle_type_id  SMALLINT NOT NULL REFERENCES vehicle_types(id),
    amount           NUMERIC(8,2) NOT NULL CHECK (amount >= 0),
    valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to         TIMESTAMPTZ,
    created_by       UUID REFERENCES staff_users(id),
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX idx_rates_lookup ON toll_rates(gate_id, vehicle_type_id, valid_from DESC);

-- ---------- PAYMENTS (top-ups via gateways) ----------
CREATE TABLE payments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id),
    method         payment_method NOT NULL,
    amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    status         payment_status NOT NULL DEFAULT 'PENDING',
    gateway_ref    VARCHAR(100),                 -- Fawry ref / Paymob order id ...
    idempotency_key VARCHAR(64) UNIQUE,          -- prevents double-crediting
    raw_callback   JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ
);
CREATE INDEX idx_payments_user ON payments(user_id, created_at DESC);

-- ---------- GATE PASSAGES (every detected vehicle) ----------
CREATE TABLE gate_passages (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gate_id          UUID NOT NULL REFERENCES toll_gates(id),
    vehicle_id       UUID REFERENCES vehicles(id),         -- NULL if unregistered
    detected_plate   VARCHAR(20),                          -- raw ANPR output (normalized)
    anpr_confidence  NUMERIC(4,3),                         -- 0.000 - 1.000
    method           identify_method NOT NULL,
    image_url        TEXT,                                 -- plate crop / full frame
    status           passage_status NOT NULL,
    amount_charged   NUMERIC(8,2) NOT NULL DEFAULT 0,
    passed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_passages_gate_time ON gate_passages(gate_id, passed_at DESC);
CREATE INDEX idx_passages_vehicle   ON gate_passages(vehicle_id, passed_at DESC);
CREATE INDEX idx_passages_plate     ON gate_passages(detected_plate);

-- ---------- WALLET LEDGER (append-only; source of truth for history) ----------
CREATE TABLE wallet_transactions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id      UUID NOT NULL REFERENCES wallets(id),
    type           wallet_txn_type NOT NULL,
    amount         NUMERIC(12,2) NOT NULL,                 -- + credit, - debit
    balance_after  NUMERIC(12,2) NOT NULL,
    passage_id     UUID REFERENCES gate_passages(id),
    payment_id     UUID REFERENCES payments(id),
    description    VARCHAR(255),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (type = 'TOLL_DEDUCTION' AND passage_id IS NOT NULL) OR
        (type = 'TOPUP'          AND payment_id IS NOT NULL) OR
        (type NOT IN ('TOLL_DEDUCTION','TOPUP'))
    )
);
CREATE INDEX idx_wtxn_wallet_time ON wallet_transactions(wallet_id, created_at DESC);
-- One toll deduction per passage (idempotency)
CREATE UNIQUE INDEX uq_wtxn_passage_deduction
    ON wallet_transactions(passage_id) WHERE type = 'TOLL_DEDUCTION';

-- ---------- INSUFFICIENT BALANCE PROTOCOL ----------
CREATE TABLE violations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    passage_id    UUID NOT NULL UNIQUE REFERENCES gate_passages(id),
    vehicle_id    UUID REFERENCES vehicles(id),
    user_id       UUID REFERENCES users(id),
    toll_amount   NUMERIC(8,2) NOT NULL,
    fine_amount   NUMERIC(8,2) NOT NULL DEFAULT 0,
    status        violation_status NOT NULL DEFAULT 'OPEN',
    due_date      DATE,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_violations_user_status ON violations(user_id, status);

-- ---------- SECURITY: STOLEN VEHICLES ----------
CREATE TABLE stolen_vehicle_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plate_number    VARCHAR(20) NOT NULL,
    vehicle_id      UUID REFERENCES vehicles(id),
    report_number   VARCHAR(50) UNIQUE,              -- police report ref
    reported_by     UUID REFERENCES staff_users(id),
    description     TEXT,
    status          report_status NOT NULL DEFAULT 'ACTIVE',
    reported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ
);
CREATE INDEX idx_stolen_plate_active ON stolen_vehicle_reports(plate_number) WHERE status = 'ACTIVE';

CREATE TABLE security_alerts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id     UUID NOT NULL REFERENCES stolen_vehicle_reports(id),
    passage_id    UUID NOT NULL REFERENCES gate_passages(id),
    gate_id       UUID NOT NULL REFERENCES toll_gates(id),
    status        alert_status NOT NULL DEFAULT 'NEW',
    handled_by    UUID REFERENCES staff_users(id),
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    handled_at    TIMESTAMPTZ
);
CREATE INDEX idx_alerts_status ON security_alerts(status, created_at DESC);

-- ---------- NOTIFICATIONS (in-app inbox + push log) ----------
CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(120) NOT NULL,
    body        TEXT NOT NULL,
    data        JSONB,                       -- e.g. {"passage_id": "..."}
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_user ON notifications(user_id, created_at DESC);

-- ---------- AUDIT / SYSTEM LOGS ----------
CREATE TABLE audit_logs (
    id           BIGSERIAL PRIMARY KEY,
    actor_type   VARCHAR(10) NOT NULL CHECK (actor_type IN ('USER','STAFF','GATE','SYSTEM')),
    actor_id     UUID,
    action       VARCHAR(80) NOT NULL,        -- e.g. 'RATE_UPDATED', 'USER_SUSPENDED'
    entity_type  VARCHAR(50),
    entity_id    UUID,
    details      JSONB,
    ip_address   INET,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_time   ON audit_logs(created_at DESC);

-- ---------- SEED DATA ----------
INSERT INTO vehicle_types (code, name) VALUES
 ('MOTORCYCLE','Motorcycle'), ('CAR','Private Car'), ('MICROBUS','Microbus'),
 ('BUS','Bus'), ('TRUCK','Truck');
