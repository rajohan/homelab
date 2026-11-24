CREATE TABLE "mira_calendar_events" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"title" text NOT NULL,
	"notes" text NOT NULL,
	"location" text NOT NULL,
	"all_day" boolean NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mira_calendar_interval" CHECK ("ends_at" > "starts_at"),
	CONSTRAINT "mira_calendar_creator" CHECK ("created_by" in ('operator','mira'))
);
--> statement-breakpoint
ALTER TABLE "update_policies" ADD COLUMN "allow_digest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_daytona_jobs" ALTER COLUMN "sandbox_id" SET DATA TYPE text USING "sandbox_id"::text;--> statement-breakpoint
CREATE INDEX "mira_calendar_owner_start" ON "mira_calendar_events" ("owner","starts_at","id");
--> statement-breakpoint
-- Preserve consent only for the 18 packaged recipes whose workspace path changed.
-- Hashes are updateTargetRevision(parseUpdateTargets(...)) before and after the rename.
-- All other recipe changes still require review. Enabled, allow_digest and version retain their values.
UPDATE update_policies AS policy SET configuration = paths.current_revision
FROM (VALUES
    ('stremio-aiostreams', '78e5b9ffb9eeae6b3a926a6fdb303164cfaeb16475438cdb5633d7ce937c43ce', 'fc5afa5f5773f88e6cb9733c4f6a4d327b4be037b82e5f363f13564153f969f2'),
    ('stremio-jackett', '60e8059372a25f857942d441a8f4b18af03a1a586198d1c87bb56c63c71153bd', 'a65bb9847dc363de53543a35157bd3fd0c3bc4fc1dffff52ce164be6d9e97b0c'),
    ('stremio-crosswatch', 'b778295d22ec0e40209ea6e0e23211c007ef6e69b9c41b1a035dc904a499dde0', 'ee10a0cb031faa6ce71e884602603a3b209e58bb2a464407b87a2da53058416b'),
    ('stremio-aiometadata', '7a71d173ba4f66656584996e2963c32a5c4163842ad0c871ebb03207b38d5ab3', 'ff4cb2db901d2e7bbc69f2dfffe67fbe2a66d03ca213a004450fd04d9b84b722'),
    ('stremio-valkey-submaker', '91ee56fdeb61d44c7a77c94503fd14fae2d8dbefcebf908b69e62103bf998dfc', '472e51d4878bd953e5e56a219fdc90e4cff17abfe6bca6d80a25ab433276ead1'),
    ('stremio-valkey-cache', 'c3feed7c6721b1a67b01f69ef2213b02653b45746f08681355d5784d8f548451', '7a91f01b6d7ac6666dd0cc2a97805db1e0ad4f08a4d170ba911b6e33fdca4909'),
    ('stremio-submaker', 'cc2cbb34d630737e7765fa00aeb972d00675743b4df72b660b34a2c18c378ba9', '00ced0947e2788576f65809830b73a9e972fe2d378adcd05240e476978810f0c'),
    ('stremio-mediaflow', '9f3c1fc543e58a9b0d68cad128c909bb28eb2d7c99e6cedde93e4667e6ff2d5d', '1110a1e533d74eacfd7e3cc7e1c232934de641eee6b5c21cdabf64a6b7887b64'),
    ('stremio-bitmagnet', '1ad620529c893a36c1957e925a8e294ff682f7c6a2380deb445bbd69a6354bd6', '3fbe2c18c0d505fe779cca2490ae3f0bf9b03486fd1f482958472daf6b0cecad'),
    ('stremio-gost', 'd182022dd86d67459f961a2b52da6bf3fa7befd4413ec31a17095e9dc45e0590', '440320a3198b9e2fadbd76f5a6531757fe79d4a4d3a9760d8afe68d8192a789e'),
    ('stremio-flaresolverr', 'fe384a992fe84210665e1cc50af6711a3044bb8405d205edd4a295b3f23b561c', '67cd77929094f6301f0a1a82cf68192ce5f97ee52343e0c7f5142d2cdf37c748'),
    ('stremio-gluetun', 'db1128048ac1bd53bf8b295ee27f863a35e8367ad708c16f316f516989fdeb89', '17c8910e144e119f30da826152646ac73c4a15bcd1bd2312f9c1c404a772f305'),
    ('stremio-comet', '6586f5ac844185cfe8bbdb002d6c54b062785366e1d98d8e79b4a965af43ee1a', '3a295b6214d1be59057cbb0f3d0f1ec31b409f98110b177a38862e8674b82a97'),
    ('tools-it-tools', '588d025c876bbf8fe7715162cb6f489713c95ec28377bb608da215bdbd4857a3', '88480b920897950e0a417bbbcaef1fb0a1ff22a842c3a7f934d0c16771230422'),
    ('tools-shlink', '203e40e0005601ff33aafc66023a699e147dd119304e4f2cb5c9a8fb97a5dc51', '9bba7e5897697ff6f421166d671971d985a76e7c2c79b8fbedd669371f2100ba'),
    ('tools-valkey-shlink', 'd7566f668b12bed61cfb0f4ced46493177a577b2d67d25514bdc98478c68916e', 'fa19bf5f923f71a59e98c8ef407ad1249d54bf882340dd30017539766372395e'),
    ('tools-openspeedtest', 'c2ffa666fc3d5676fcff883f401753e54e2b5cb7674625b8889698c8b80d120f', '59dc9b8b0137d3b3890f53fcf2d7a5aa8bf228492df23d093269bcdcbccf4a7f'),
    ('tools-shlink-web', '55840998df6e3ec36f5775879f3efd95c3588697afb377056677583e087e8cd6', 'd1469e458883d9cf80a4d7d66d91a71eedf1b1a785da145c49ea9f81c2fe6482')
) AS paths(target, previous_revision, current_revision)
WHERE policy.target = paths.target AND policy.configuration = paths.previous_revision;
