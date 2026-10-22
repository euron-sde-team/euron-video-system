// Every integration test process talks to the throwaway test database only.
process.env.NODE_ENV = "test";
process.env.TZ = "UTC";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.UPLOADS_BUCKET ??= "itest-uploads";
process.env.MEDIA_BUCKET ??= "itest-media";
process.env.DOWNLOADS_BUCKET ??= "itest-downloads";
process.env.DATA_ENCRYPTION_KEY ??= "integration-test-data-encryption-key-0123456789";
process.env.PUBLIC_API_BASE ??= "http://localhost:8080";
process.env.API_KEY_PEPPER ??= "integration-test-api-key-pepper-0123456789abcdef";
process.env.PLAYBACK_SIGNING_KEYS ??= "itest=integration-test-playback-signing-key-0123456789";
process.env.PLAYBACK_ACTIVE_KID ??= "itest";
process.env.WEBHOOK_DISPATCH_ENABLED ??= "false";
delete process.env.KMS_KEY_ID;
