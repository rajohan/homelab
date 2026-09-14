const mode = process.argv[2];
const integration = mode === "integration";
const coverage = mode === "coverage";
const timings = mode === "timings";
if (process.argv.length > 3 || (mode && !integration && !coverage && !timings)) {
    throw new Error(
        "Use bun run test, bun run test:coverage, bun run test:integration or bun run test:timings."
    );
}

const files = [...new Bun.Glob("{apps,packages}/**/*.test.{ts,tsx}").scanSync(".")]
    .filter((file) => !file.includes("node_modules/") && !file.includes("/dist/"))
    .filter((file) => file.includes(".integration.test.") === integration)
    .toSorted();

if (files.length === 0) {
    throw new Error(`No ${integration ? "integration" : "unit/component"} tests found.`);
}

const groups = integration
    ? [{ name: "integration", files, preload: [] }]
    : [
          {
              name: "unit",
              files: files.filter((file) => file.endsWith(".ts")),
              preload: [],
          },
          {
              name: "component",
              files: files.filter((file) => file.endsWith(".tsx")),
              preload: ["--preload", "./tests/dom.ts"],
          },
      ];

for (const group of groups) {
    if (group.files.length === 0) continue;
    const coverageDirectory = `coverage/${group.name}`;
    const coverageArguments = coverage
        ? [
              "--coverage",
              "--coverage-reporter=text",
              "--coverage-reporter=lcov",
              `--coverage-dir=${coverageDirectory}`,
          ]
        : [];
    const timingsFile =
        group.name === "unit"
            ? ".bun-test-timings.json"
            : ".bun-browser-test-timings.json";
    const timingArguments = integration
        ? []
        : [
              "--parallel=2",
              ...(timings || (await Bun.file(timingsFile).exists())
                  ? [`--timings=${timingsFile}`]
                  : []),
              ...(timings ? ["--update-timings"] : []),
          ];
    const child = Bun.spawn(
        [
            process.execPath,
            "test",
            ...group.preload,
            ...coverageArguments,
            ...timingArguments,
            ...group.files.map((file) => `./${file}`),
        ],
        { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
    );
    const result = await child.exited;
    if (result !== 0) {
        process.exitCode = result;
        break;
    }
    if (coverage && !(await Bun.file(`${coverageDirectory}/lcov.info`).exists())) {
        throw new Error(`The ${group.name} coverage report was not generated.`);
    }
}
