// Deterministic, obviously-fake configuration for unit tests.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://evs:evs@localhost:5432/evs_test";
process.env.UPLOADS_BUCKET ??= "test-uploads";
process.env.MEDIA_BUCKET ??= "test-media";
process.env.DOWNLOADS_BUCKET ??= "test-downloads";
process.env.DATA_ENCRYPTION_KEY ??= "unit-test-data-encryption-key-0123456789abcdef";
delete process.env.KMS_KEY_ID;
