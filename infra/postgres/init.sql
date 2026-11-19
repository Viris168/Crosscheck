-- Runs once, on the first start of an empty postgres volume.
-- `app` is created by POSTGRES_DB; Inngest gets its own database.
CREATE DATABASE inngest OWNER app;
