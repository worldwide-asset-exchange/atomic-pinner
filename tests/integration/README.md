# Integration tests

These run the whole pipeline against a real [Kubo](https://github.com/ipfs/kubo) node and a
stub AtomicAssets API, and are skipped unless `KUBO_API_URL` is set.

```bash
docker run -d --name kubo -p 5001:5001 -p 8080:8080 \
  -v "$PWD/tests/integration/kubo-init:/container-init.d" ipfs/kubo:v0.32.1
KUBO_API_URL=http://127.0.0.1:5001 KUBO_GATEWAY_URL=http://127.0.0.1:8080 yarn test:integration
docker rm -f kubo
```

The init script binds the API and gateway to all interfaces and keeps the node offline, so the
test adds a file to the node, lets atomic-pinner discover it through the stub API, and checks
it ends up pinned. CI does the same in the `integration` job.
