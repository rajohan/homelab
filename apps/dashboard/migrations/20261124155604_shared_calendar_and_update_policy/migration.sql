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
-- Preserve consent only for the 18 packaged recipes whose workspace paths and Compose project names changed.
-- Hashes are updateTargetRevision(parseUpdateTargets(...)) before and after the rename.
-- All other recipe changes still require review. Enabled, allow_digest and version retain their values.
UPDATE update_policies AS policy SET configuration = names.current_revision
FROM (VALUES
    ('stremio-aiostreams', '78e5b9ffb9eeae6b3a926a6fdb303164cfaeb16475438cdb5633d7ce937c43ce', 'fc5afa5f5773f88e6cb9733c4f6a4d327b4be037b82e5f363f13564153f969f2', 'c04968322b2777b11c63390e3a38a1d95a4ed76f416b2697d2cf2243bbf33328', 'bb6c3ba7a4c9e2b5ab904ea4c81807c8dafa3d05f20ffe2440dc0bbeba62440c'),
    ('stremio-jackett', '60e8059372a25f857942d441a8f4b18af03a1a586198d1c87bb56c63c71153bd', 'a65bb9847dc363de53543a35157bd3fd0c3bc4fc1dffff52ce164be6d9e97b0c', 'a92dc9d505b072c5f444f13802296f1d876a91d6fe795fc6ff0ac5b25d320478', '4c5657e93c258f28fe9c0080f8e6e34272a3d544a0e7caa709e91a503289e91f'),
    ('stremio-crosswatch', 'b778295d22ec0e40209ea6e0e23211c007ef6e69b9c41b1a035dc904a499dde0', 'ee10a0cb031faa6ce71e884602603a3b209e58bb2a464407b87a2da53058416b', '421260ef4e73395a2140c854403acb49618359123df5adc95ac57c5e00041fab', '78a8efcb24058f58b05f91939fc4e962f8f22853c2b30c6fe96dde827f82ed1d'),
    ('stremio-aiometadata', '7a71d173ba4f66656584996e2963c32a5c4163842ad0c871ebb03207b38d5ab3', 'ff4cb2db901d2e7bbc69f2dfffe67fbe2a66d03ca213a004450fd04d9b84b722', 'bab3c466c716f11edfad96cae32fac082f32206c340271c4f44cc9600a8f7f4b', 'fff673832a590e0dc6fca8c4f0ae728942f732a849ca8e44ace82c357ad57bf6'),
    ('stremio-valkey-submaker', '91ee56fdeb61d44c7a77c94503fd14fae2d8dbefcebf908b69e62103bf998dfc', '472e51d4878bd953e5e56a219fdc90e4cff17abfe6bca6d80a25ab433276ead1', '0edea4c2e9b44cc14810da010fefb212dcdc70e151f5012d8af61e4540d6441d', '6ce70f9e947987744429ade2c8858a8701f5a42017f88023f1f4b1a040e33068'),
    ('stremio-valkey-cache', 'c3feed7c6721b1a67b01f69ef2213b02653b45746f08681355d5784d8f548451', '7a91f01b6d7ac6666dd0cc2a97805db1e0ad4f08a4d170ba911b6e33fdca4909', '5bc713a3209e99cdd21f92d0527fe68dea9dd43c60ff5921eacfa4fecc987cc3', 'eea0c905c57c2d71b3cb083624a54ed7f59a25a96412e2b7d6ec16d18fae644d'),
    ('stremio-submaker', 'cc2cbb34d630737e7765fa00aeb972d00675743b4df72b660b34a2c18c378ba9', '00ced0947e2788576f65809830b73a9e972fe2d378adcd05240e476978810f0c', '9602be415e94b1ec5187838356d2737515d60c104a116b3aecc522f0edf78332', '9eb63239ced2619aeb3203d0085296b3bbe60d88f97ef289c5775a26757b5a27'),
    ('stremio-mediaflow', '9f3c1fc543e58a9b0d68cad128c909bb28eb2d7c99e6cedde93e4667e6ff2d5d', '1110a1e533d74eacfd7e3cc7e1c232934de641eee6b5c21cdabf64a6b7887b64', 'baa6503ce8869212069f60347a3cdda5c7494153887a10040f7411472bcd10cc', '5c265ca2657714ea9753907fa8d6e2ac0f0aff8ce7c4cfe4bef5e84b1ba6f07f'),
    ('stremio-bitmagnet', '1ad620529c893a36c1957e925a8e294ff682f7c6a2380deb445bbd69a6354bd6', '3fbe2c18c0d505fe779cca2490ae3f0bf9b03486fd1f482958472daf6b0cecad', 'bde7942d604651432ce3a312f59432ef7645eb9873341a0cde273f2d73b61c77', '9465146b3fcb9b5e1345723464d9115286044004e910ba98cf5af98078e7bb9e'),
    ('stremio-gost', 'd182022dd86d67459f961a2b52da6bf3fa7befd4413ec31a17095e9dc45e0590', '440320a3198b9e2fadbd76f5a6531757fe79d4a4d3a9760d8afe68d8192a789e', 'ee2f6e15a694b2caa41411756f263d6e9241db4922636731898c4738b43333a2', 'c4e9909fb4d7b615b0f45ea716144c370ae4a8aa3d3b603061845ccd9c131e5d'),
    ('stremio-flaresolverr', 'fe384a992fe84210665e1cc50af6711a3044bb8405d205edd4a295b3f23b561c', '67cd77929094f6301f0a1a82cf68192ce5f97ee52343e0c7f5142d2cdf37c748', '2ad4c54dfa05306f9f04def9ae3e28a30b39922053c13c956afee438dd8f4e5c', '80431bb68aa34e4e83502a397fb8f28fc929c916c53ab07118d9129c6c8539a3'),
    ('stremio-gluetun', 'db1128048ac1bd53bf8b295ee27f863a35e8367ad708c16f316f516989fdeb89', '17c8910e144e119f30da826152646ac73c4a15bcd1bd2312f9c1c404a772f305', 'a8f57c7739f69c07a7b3b6783e2a0affa20823f4c9e2ef1892f936faa92bba72', 'add9076bb73bda9b9f417f47d00483a0ce339fda848c7b4093c6948a07ec96cd'),
    ('stremio-comet', '6586f5ac844185cfe8bbdb002d6c54b062785366e1d98d8e79b4a965af43ee1a', '3a295b6214d1be59057cbb0f3d0f1ec31b409f98110b177a38862e8674b82a97', '2073e6106ba61bf59c0fceb7d34fb378ce58792a56c25cab06942b0f517c95ae', 'af5c0d50c48ae4fddab7ab5d7a90ee1576593f627e1cc90c83015f8d792594a6'),
    ('tools-it-tools', '588d025c876bbf8fe7715162cb6f489713c95ec28377bb608da215bdbd4857a3', '88480b920897950e0a417bbbcaef1fb0a1ff22a842c3a7f934d0c16771230422', '10c275d594031f74be69a21e09590013d0dff20869884f52575e9727f6642f6b', NULL),
    ('tools-shlink', '203e40e0005601ff33aafc66023a699e147dd119304e4f2cb5c9a8fb97a5dc51', '9bba7e5897697ff6f421166d671971d985a76e7c2c79b8fbedd669371f2100ba', '5905d8989fd78fe88a68c049c40027e5c09e3a227f7c8aa0f18e5bc1b5674841', NULL),
    ('tools-valkey-shlink', 'd7566f668b12bed61cfb0f4ced46493177a577b2d67d25514bdc98478c68916e', 'fa19bf5f923f71a59e98c8ef407ad1249d54bf882340dd30017539766372395e', 'b074ec6092c4deaeac0c70d0bd9a8cdd58a250ced226a40c89ddf27e92f4a958', NULL),
    ('tools-openspeedtest', 'c2ffa666fc3d5676fcff883f401753e54e2b5cb7674625b8889698c8b80d120f', '59dc9b8b0137d3b3890f53fcf2d7a5aa8bf228492df23d093269bcdcbccf4a7f', '797d868f348aa608151e5d86455100112056e96b827fbd3d8052a147da7cf163', NULL),
    ('tools-shlink-web', '55840998df6e3ec36f5775879f3efd95c3588697afb377056677583e087e8cd6', 'd1469e458883d9cf80a4d7d66d91a71eedf1b1a785da145c49ea9f81c2fe6482', '6b37dc2da290c7363cac1e9b60ca808bd89b81531b5031b118a3d15eff7e1799', NULL)
) AS names(target, previous_revision, path_revision, current_revision, loader_alias_revision)
WHERE policy.target = names.target AND policy.configuration IN (names.previous_revision, names.path_revision, names.loader_alias_revision);
