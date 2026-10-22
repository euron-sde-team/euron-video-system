// Unit tests never touch a database or a cloud; config still has to validate.
process.env.NODE_ENV ??= "test";
process.env.TZ = "UTC";
process.env.DATABASE_URL ??= "postgres://unit:unit@127.0.0.1:1/unit";
process.env.UPLOADS_BUCKET ??= "unit-uploads";
process.env.MEDIA_BUCKET ??= "unit-media";
process.env.DOWNLOADS_BUCKET ??= "unit-downloads";
process.env.DATA_ENCRYPTION_KEY ??= "unit-test-data-encryption-key-0123456789abcdef";
process.env.PUBLIC_API_BASE ??= "https://api.example.com";
process.env.API_KEY_PEPPER ??= "unit-test-api-key-pepper-0123456789abcdef";
process.env.PLAYBACK_SIGNING_KEYS ??= "unit=unit-test-playback-signing-key-0123456789";
process.env.PLAYBACK_ACTIVE_KID ??= "unit";
process.env.AWS_REGION ??= "us-east-1";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
