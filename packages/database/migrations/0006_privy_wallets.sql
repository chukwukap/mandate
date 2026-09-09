-- Spend permissions are gone: users trade from Privy embedded wallets they delegate to the app.
-- The table held prepared/signed/active permission rows for the retired Coinbase design; the
-- transactions journal keeps its wider leg vocabulary so old journals stay readable.
DROP TABLE IF EXISTS "mandate_v2"."permissions" CASCADE;
