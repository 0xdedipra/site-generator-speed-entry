# Faster byte-exact static site generator

An entry for make.fun's **site-generator-speed-01-run-20261122** bounty, "Build a static site
faster, 22 November 2026".

`solve.js` is an original, dependency-free ES module whose `run(input)` returns, for every case's
input `{ site, templates, files }`, exactly the output tree makefun-site 1.0.0's build returns —
each page's `index.html`, the index and tag pages, `build-report.txt` and each static file, byte
for byte — at a fraction of its CPU time. `main.ts` is the program the harness runs: it reads
every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## Run it

```sh
node main.ts
```

with `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` naming the input and output directories outside
a container (they default to `/input` and `/output`).
