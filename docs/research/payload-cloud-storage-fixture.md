# Payload cloud-storage fixture for Payload 3.88

## Recommendation

Use one minimal upload collection, one `@payloadcms/storage-s3` configuration with
`clientUploads: true`, one bucket, one small static fixture file, and one pinned
LocalStack S3 service. This is the smallest credible fixture for Payload
`>=3.88 <4`: exercise the server path with a REST multipart or Local API upload,
then exercise the browser path through Admin with the same collection.
At the time of research, `v3.88.0` is the current stable Payload release
([official release](https://github.com/payloadcms/payload/releases/tag/v3.88.0));
pin Payload and its official adapter packages to the same selected 3.x version
rather than using `latest`, which will eventually cross the v4 boundary.

This recommendation is an inference from the v3.88.0 implementation. A normal
incoming file has no `clientUploadContext`, so the cloud-storage `afterChange`
hook calls the adapter's `handleUpload`; a file already uploaded by the client
has that context and is filtered out of the server upload
([hook source](https://github.com/payloadcms/payload/blob/v3.88.0/packages/plugin-cloud-storage/src/hooks/afterChange.ts#L24-L40)).
Therefore two collections, two Payload configs, or two storage services are not
required merely to cover the two paths.

## Verified facts

- The official S3 adapter accepts the AWS SDK's complete `S3ClientConfig`, spreads
  it into `AWS.S3`, and exposes `clientUploads` as an adapter option
  ([adapter options and construction](https://github.com/payloadcms/payload/blob/v3.88.0/packages/storage-s3/src/index.ts#L41-L72),
  [client construction](https://github.com/payloadcms/payload/blob/v3.88.0/packages/storage-s3/src/index.ts#L122-L140)).
  The current Payload documentation also shows an S3-compatible R2 endpoint with
  `endpoint` and `forcePathStyle: true`, so the adapter is not restricted to AWS-hosted S3
  ([Payload storage-adapter docs](https://payloadcms.com/docs/upload/storage-adapters#using-with-cloudflare-r2-via-s3-api)).
- In the server path, the adapter passes the file buffer or stream to the S3
  upload implementation through `handleUpload`
  ([S3 adapter source](https://github.com/payloadcms/payload/blob/v3.88.0/packages/storage-s3/src/adapter.ts#L48-L73)).
  Payload's v3.88.0 integration test performs a Local API upload and verifies the
  resulting S3 objects
  ([official server-upload test](https://github.com/payloadcms/payload/blob/v3.88.0/test/storage-s3/int.spec.ts#L33-L64)).
- With `clientUploads` enabled, Payload registers a signed-URL endpoint
  ([S3 plugin source](https://github.com/payloadcms/payload/blob/v3.88.0/packages/storage-s3/src/index.ts#L143-L162)).
  The client sends credentials to that Payload endpoint, receives a presigned
  URL, and sends the file directly to it with `PUT`
  ([client handler](https://github.com/payloadcms/payload/blob/v3.88.0/packages/storage-s3/src/client/S3ClientUploadHandler.ts#L15-L64)).
  The default signed-URL access rule requires `req.user`, and the URL expires
  after 600 seconds
  ([signing handler](https://github.com/payloadcms/payload/blob/v3.88.0/packages/storage-s3/src/generateSignedURL.ts#L24-L32),
  [presigning](https://github.com/payloadcms/payload/blob/v3.88.0/packages/storage-s3/src/generateSignedURL.ts#L74-L107)).
- Payload v3.88.0 itself tests S3 against LocalStack with a custom HTTP endpoint,
  dummy credentials, region, and path-style addressing
  ([official environment](https://github.com/payloadcms/payload/blob/v3.88.0/test/plugin-cloud-storage/.env.emulated#L12-L17),
  [official client-upload config](https://github.com/payloadcms/payload/blob/v3.88.0/test/storage-s3/client-uploads/config.ts#L37-L58)).
  Its browser test asserts that a `PUT` reaches S3 and that no file-sized request
  reaches Payload
  ([official E2E assertion](https://github.com/payloadcms/payload/blob/v3.88.0/test/storage-s3/client-uploads/e2e.spec.ts#L63-L100)).

## Real CI constraints

1. **One endpoint must be reachable by both processes.** The configured S3
   endpoint is used by the server-side AWS client and appears in the URL fetched
   by the browser. On a conventional CI runner, publish LocalStack port `4566`
   and use `http://localhost:4566` for the Payload process and Playwright. A
   Docker-only hostname such as `http://localstack:4566` will fail when the
   browser runs outside that Docker network. `forcePathStyle: true` avoids
   bucket-as-subdomain DNS requirements. This is an inference from the adapter's
   endpoint use and the official localhost fixture above.
2. **CORS is part of the fixture, not optional test polish.** Payload's docs say
   the bucket must allow browser `PUT` when `clientUploads` is enabled
   ([official docs](https://payloadcms.com/docs/upload/storage-adapters#s3-storage)).
   Payload's LocalStack initialization creates the bucket and installs a CORS
   rule with `PUT`, wildcard request headers, and a browser origin allowance
   ([official initialization script](https://github.com/payloadcms/payload/blob/v3.88.0/test/localstack-init/ready.d/01-s3-cors.sh#L1-L17)).
   For isolated CI, its wildcard origin avoids coupling to a test-server port;
   production should name the real site origin.
3. **Credentials remain necessary.** The server needs an access-key/secret pair
   to call S3 and sign the `PutObject` URL; the browser receives only the
   time-limited presigned URL. Use fixed non-secret emulator credentials in CI.
   Keep the default authenticated-user rule and seed/login one Admin user rather
   than weakening upload access just for the fixture.
4. **Verify routing, not only success.** The server-path check should upload and
   `HeadObject` the result. The Admin E2E check should additionally observe a
   browser `PUT` to the S3 host and reject any file-sized request to the Payload
   host, matching Payload's own test. Merely finding the object cannot distinguish
   the two paths.

## Hosted Cloudflare R2 versus LocalStack

**Recommendation:** document Cloudflare R2 as the intended hosted S3-compatible
target, but keep the pinned LocalStack service above as the routine, blocking PR
fixture. Add at most one optional, secret-gated R2 smoke lane (scheduled or
manually dispatched); do not make every PR depend on a real R2 account.

### Verified facts

- Payload explicitly recommends `@payloadcms/storage-s3` for R2's S3 API from
  Node.js environments. Its documented configuration uses the account endpoint,
  R2 API access key and secret, `region: 'auto'`, and
  `forcePathStyle: true`; `@payloadcms/storage-r2` is instead for a native bucket
  binding inside Cloudflare Workers
  ([Payload's R2 guidance](https://payloadcms.com/docs/upload/storage-adapters#using-with-cloudflare-r2-via-s3-api)).
- R2's hosted S3 API is account-scoped at
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Cloudflare's presigned-URL
  documentation supports `PUT` and direct browser use without exposing the API
  credentials
  ([R2 API surfaces](https://developers.cloudflare.com/r2/api/),
  [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)).
  Browser use still requires a bucket CORS policy permitting the application's
  origin and operation; a valid signature alone does not bypass CORS
  ([R2 CORS documentation](https://developers.cloudflare.com/r2/buckets/cors/)).
- A real lane needs an R2-enabled Cloudflare account, account ID, bucket, endpoint,
  and an access key/secret. Cloudflare says R2 must be purchased before an API
  token can be generated, and an Object Read & Write token can be scoped to a
  specific bucket
  ([R2 authentication](https://developers.cloudflare.com/r2/api/tokens/)).
  Configure the smoke bucket and its CORS policy outside the test, then give CI
  only the bucket-scoped object token; disposable bucket creation and CORS
  mutation would require broader bucket-management authority.
- R2 has usage-based storage and operation charges, although Standard storage
  currently includes monthly free allowances and egress is free
  ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). Thus a tiny smoke
  test is likely to remain inside the allowance, but it still consumes a real
  billed-account resource rather than a cost-free local fixture.
- Cloudflare does provide local R2 data through Wrangler/Miniflare, but describes
  it as a local resource used through a Worker binding and Wrangler's `--local`
  commands
  ([local data](https://developers.cloudflare.com/workers/local-development/local-data/),
  [Wrangler R2 commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/)).
  Cloudflare documents the S3-compatible API separately as the hosted account
  endpoint. No official source found documents a disposable local S3 endpoint
  matching that surface.

### Inferences and test contract

- Wrangler/Miniflare's local R2 binding is **not a drop-in emulator** for this
  Payload fixture: the Node.js S3 adapter expects an S3 HTTP endpoint and AWS
  signing, while the local facility exposes the Workers `R2Bucket` binding or
  Wrangler commands. A Worker proxy would add a second adapter boundary and
  would no longer test Payload's documented R2-via-S3 setup.
- Pinned LocalStack is the deterministic PR choice: it requires no provider
  secrets, paid account, public network, shared remote state, or cleanup after an
  interrupted CI run. It verifies Payload's generic S3 operations, presigning,
  browser CORS, and server/client routing, but it cannot prove R2-specific S3
  compatibility or the deployed R2 CORS policy.
- The optional real-provider lane should reuse one dedicated private bucket,
  isolate each run under a unique object-key prefix, run one server upload and
  one browser `clientUploads` upload, verify and delete both objects, and use a
  fixed browser origin allowed by the bucket's CORS policy. Its purpose is a
  narrow provider-contract smoke test; external network availability, credential
  rotation, service behavior, and shared account state make it unsuitable as a
  blocking test on every PR.

## MinIO and alternatives

**Verified:** MinIO describes its server as S3-compatible, and its configuration
supports global CORS origins
([official MinIO source](https://github.com/minio/minio),
[official configuration reference](https://github.com/minio/minio/blob/master/docs/config/README.md#api)).
Combined with the adapter's arbitrary `S3ClientConfig`, this makes a MinIO target
technically realistic using its endpoint, matching credentials, region, and
`forcePathStyle: true`. Payload does not explicitly name MinIO as a supported
target, so exact interoperability is an inference, not a Payload guarantee.

Do not choose MinIO for this fixture now. Its official community repository is
archived and says current Community Edition is source-only; historical binaries
are unmaintained
([official distribution notice](https://github.com/minio/minio#source-only-distribution)).
A self-built or stale pinned image is not materially smaller operationally than
the LocalStack image already exercised by Payload. I found no official adapter
alternative that removes the need for a storage service, a server upload check,
and a real browser-direct check, so changing providers would not materially
simplify this contract.
