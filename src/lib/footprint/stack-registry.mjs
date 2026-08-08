// The stack registry — the curated catalog of every language, framework, SDK and
// tool this kit can name (ADR-0025 §4, docs/ddd/machine-footprint.md "Project
// footprint"). Detection lives next door in `stack-detect.mjs`; this file only
// says what a match MEANS.
//
// PURE DATA, NO I/O — the same discipline as src/lib/dashboard/about-directory.mjs.
// Importing this module has no side effects, so a unit test can assert the whole
// catalog without a machine to measure and a reviewer can read a release's stack
// vocabulary as a diff.
//
// LINES BELONG TO LANGUAGES, ONLY. A 'language' entry owns extensions and therefore
// owns lines. A framework / sdk / tool entry is PRESENCE ONLY and must never be
// given a line count: react does not own lines, the .tsx files do, and putting both
// on one proportional bar would count the same bytes twice.
//
// AN UNMAPPED EXTENSION IS NEVER COUNTED. On a real machine most unmapped
// extensions are binaries and data (.jsonl, .png, .jar, .dll), not source, so
// guessing would inflate every total. The unmapped tail is instead surfaced BY NAME
// by stack-detect.mjs — which turns "Other" from a shrug into a to-do list this
// registry shrinks release by release.
//
// VERSIONED because it is an artifact that grows. A snapshot records the version
// that produced it, so a figure that moved between releases can be explained by the
// registry that changed rather than by the machine that did not.

/** Bump on every entry change. Date-ordinal so a snapshot's provenance reads
 *  without a lookup table; consumers compare for equality, never for ordering. */
export const STACK_REGISTRY_VERSION = '2026.08.1';

/** The closed set of ecosystem tags. Closed on purpose: an open string field
 *  becomes a synonym pile ('js' / 'javascript' / 'node') that no grouping can
 *  reconcile. Adding a tag is a registry change, reviewed with the entry. */
export const ECOSYSTEMS = Object.freeze([
  'node', 'web', 'rust', 'go', 'python', 'ruby', 'php', 'jvm', 'dotnet', 'apple',
  'beam', 'native', 'functional', 'shell', 'docs', 'data', 'infra', 'ai', 'mobile',
  'gamedev', 'other',
]);

/** Palette SLOTS, not colours. The registry names the token; the stylesheet owns
 *  the hue — the same split as about-directory's `hue`, so a theme change never
 *  requires a data change. */
export const COLOR_SLOTS = Object.freeze([
  'js', 'ts', 'rust', 'go', 'python', 'ruby', 'php', 'jvm', 'dotnet', 'apple',
  'beam', 'native', 'functional', 'shell', 'markup', 'docs', 'data', 'infra', 'other',
]);

/** Manifest families. A dependency name only means something inside one of these:
 *  `openai` is one package on npm and a different one on PyPI, and an entry says
 *  which manifests its names are valid in. */
export const MANIFEST_KINDS = Object.freeze([
  'npm', 'cargo', 'gomod', 'python', 'jvm', 'pub', 'hex', 'composer', 'rubygems',
]);

/** Manifest FILENAME → manifest kind. `manifestKindFor` is the accessor; this map
 *  is exported so a caller can state which filenames it looked for. */
export const MANIFEST_FILES = Object.freeze({
  'package.json': 'npm',
  'cargo.toml': 'cargo',
  'go.mod': 'gomod',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  pipfile: 'python',
  'pom.xml': 'jvm',
  'build.gradle': 'jvm',
  'build.gradle.kts': 'jvm',
  'pubspec.yaml': 'pub',
  'mix.exs': 'hex',
  'composer.json': 'composer',
  gemfile: 'rubygems',
});

// ── entry constructors ────────────────────────────────────────────────────────
//
// `kind` says WHAT a thing is; `match.by` says HOW it is found. Those are two
// different questions and conflating them is why "is ESLint a framework?" has no
// good answer: ESLint is a tool that happens to be found in a manifest. The only
// rule that binds is the one above — `by: 'extension'` entries carry lines, every
// other entry carries presence.

const freezeList = (list) => Object.freeze([...list]);
const lower = (list) => Object.freeze(list.map((s) => s.toLowerCase()));

/** A language: extensions (and occasionally bare filenames — a Makefile has lines
 *  and no extension) mapped to one bucket, with the palette slot it renders in. */
const lang = (id, name, ecosystem, colorSlot, extensions, filenames = []) => Object.freeze({
  id,
  kind: 'language',
  name,
  ecosystem,
  colorSlot,
  match: Object.freeze({ by: 'extension', extensions: lower(extensions), filenames: lower(filenames) }),
});

/** A manifest-detected dependency. `manifests` is a list because one project can
 *  be the same thing under two ecosystems (the OpenAI SDK is npm AND PyPI), and
 *  splitting it into two entries would double it in every UI that lists names. */
const dep = (id, kind, name, ecosystem, manifests, names, prefixes = []) => Object.freeze({
  id,
  kind,
  name,
  ecosystem,
  match: Object.freeze({
    by: 'dependency',
    manifests: freezeList(manifests),
    names: lower(names),
    prefixes: lower(prefixes),
  }),
});

/** A file/directory signature. `files` and `dirs` match basenames and
 *  root-relative paths respectively; `filePrefixes` covers the families that vary
 *  by suffix (`.eslintrc.json`, `docker-compose.prod.yml`). */
const sig = (id, name, ecosystem, { files = [], dirs = [], filePrefixes = [] }) => Object.freeze({
  id,
  kind: 'tool',
  name,
  ecosystem,
  match: Object.freeze({
    by: 'signature',
    files: lower(files),
    dirs: lower(dirs),
    filePrefixes: lower(filePrefixes),
  }),
});

// ── languages ─────────────────────────────────────────────────────────────────
//
// Seeded from the LANGUAGES map projects.mjs shipped (~65 extensions) and widened.
// Bucket ids are kept byte-identical where they existed ('javascript', 'config',
// 'objective-c', …) so a snapshot taken before this registry still joins.

const LANGUAGE_ENTRIES = [
  lang('javascript', 'JavaScript', 'node', 'js', ['.js', '.mjs', '.cjs', '.jsx']),
  lang('typescript', 'TypeScript', 'node', 'ts', ['.ts', '.tsx', '.mts', '.cts']),
  lang('coffeescript', 'CoffeeScript', 'node', 'js', ['.coffee']),
  lang('rust', 'Rust', 'rust', 'rust', ['.rs']),
  lang('go', 'Go', 'go', 'go', ['.go']),
  lang('python', 'Python', 'python', 'python', ['.py', '.pyi', '.pyx']),
  lang('ruby', 'Ruby', 'ruby', 'ruby', ['.rb', '.rake', '.gemspec']),
  lang('php', 'PHP', 'php', 'php', ['.php', '.phtml']),
  lang('java', 'Java', 'jvm', 'jvm', ['.java']),
  lang('kotlin', 'Kotlin', 'jvm', 'jvm', ['.kt', '.kts']),
  lang('scala', 'Scala', 'jvm', 'jvm', ['.scala', '.sc']),
  lang('groovy', 'Groovy', 'jvm', 'jvm', ['.groovy', '.gradle']),
  lang('clojure', 'Clojure', 'jvm', 'jvm', ['.clj', '.cljs', '.cljc', '.edn']),
  lang('csharp', 'C#', 'dotnet', 'dotnet', ['.cs', '.csx']),
  lang('fsharp', 'F#', 'dotnet', 'dotnet', ['.fs', '.fsi', '.fsx']),
  lang('visual-basic', 'Visual Basic', 'dotnet', 'dotnet', ['.vb']),
  lang('razor', 'Razor', 'dotnet', 'dotnet', ['.cshtml', '.razor']),
  lang('swift', 'Swift', 'apple', 'apple', ['.swift']),
  // `.m` is Objective-C here, as it was in projects.mjs: MATLAB is the rarer
  // reading of that extension on a machine running agent CLIs.
  lang('objective-c', 'Objective-C', 'apple', 'apple', ['.m', '.mm']),
  lang('c', 'C', 'native', 'native', ['.c', '.h']),
  lang('cpp', 'C++', 'native', 'native', ['.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.ipp']),
  lang('zig', 'Zig', 'native', 'native', ['.zig']),
  lang('nim', 'Nim', 'native', 'native', ['.nim', '.nims']),
  lang('crystal', 'Crystal', 'native', 'native', ['.cr']),
  lang('assembly', 'Assembly', 'native', 'native', ['.asm', '.s']),
  lang('fortran', 'Fortran', 'native', 'native', ['.f', '.f90', '.f95', '.for']),
  lang('verilog', 'Verilog / VHDL', 'native', 'native', ['.sv', '.svh', '.vhd', '.vhdl']),
  lang('elixir', 'Elixir', 'beam', 'beam', ['.ex', '.exs']),
  lang('erlang', 'Erlang', 'beam', 'beam', ['.erl', '.hrl']),
  lang('gleam', 'Gleam', 'beam', 'beam', ['.gleam']),
  lang('haskell', 'Haskell', 'functional', 'functional', ['.hs', '.lhs']),
  lang('ocaml', 'OCaml', 'functional', 'functional', ['.ml', '.mli']),
  lang('elm', 'Elm', 'functional', 'functional', ['.elm']),
  lang('purescript', 'PureScript', 'functional', 'functional', ['.purs']),
  lang('rescript', 'ReScript', 'functional', 'functional', ['.res', '.resi']),
  lang('lisp', 'Lisp', 'functional', 'functional', ['.lisp', '.lsp', '.el']),
  lang('scheme', 'Scheme / Racket', 'functional', 'functional', ['.scm', '.ss', '.rkt']),
  lang('shell', 'Shell', 'shell', 'shell', ['.sh', '.bash', '.zsh', '.fish', '.ksh']),
  lang('powershell', 'PowerShell', 'shell', 'shell', ['.ps1', '.psm1', '.psd1']),
  lang('batch', 'Batch', 'shell', 'shell', ['.bat', '.cmd']),
  lang('perl', 'Perl', 'shell', 'shell', ['.pl', '.pm']),
  lang('vimscript', 'Vim script', 'shell', 'shell', ['.vim']),
  lang('lua', 'Lua', 'other', 'other', ['.lua']),
  lang('dart', 'Dart', 'mobile', 'other', ['.dart']),
  lang('julia', 'Julia', 'data', 'data', ['.jl']),
  lang('r', 'R', 'data', 'data', ['.r', '.rmd']),
  lang('solidity', 'Solidity', 'other', 'other', ['.sol']),
  lang('shaders', 'Shaders', 'gamedev', 'native', ['.glsl', '.frag', '.vert', '.wgsl', '.hlsl', '.metal']),
  lang('wat', 'WebAssembly text', 'native', 'native', ['.wat']),
  lang('vue', 'Vue', 'web', 'markup', ['.vue']),
  lang('svelte', 'Svelte', 'web', 'markup', ['.svelte']),
  lang('astro', 'Astro', 'web', 'markup', ['.astro']),
  lang('html', 'HTML', 'web', 'markup', ['.html', '.htm', '.xhtml']),
  lang('css', 'CSS', 'web', 'markup', ['.css', '.scss', '.sass', '.less', '.styl']),
  lang('templates', 'Templates', 'web', 'markup', [
    '.hbs', '.handlebars', '.ejs', '.pug', '.jade', '.liquid', '.njk', '.twig',
    '.erb', '.haml', '.slim', '.j2', '.jinja',
  ]),
  lang('markdown', 'Markdown', 'docs', 'docs', ['.md', '.mdx', '.markdown']),
  lang('restructuredtext', 'reStructuredText', 'docs', 'docs', ['.rst']),
  lang('asciidoc', 'AsciiDoc', 'docs', 'docs', ['.adoc', '.asciidoc']),
  lang('tex', 'TeX', 'docs', 'docs', ['.tex', '.sty', '.cls']),
  lang('diagrams', 'Diagrams as code', 'docs', 'docs', ['.mmd', '.puml', '.dot']),
  lang('sql', 'SQL', 'data', 'data', ['.sql', '.ddl']),
  lang('protobuf', 'Protocol Buffers', 'data', 'data', ['.proto']),
  lang('graphql', 'GraphQL', 'data', 'data', ['.graphql', '.gql']),
  lang('idl', 'Interface definitions', 'data', 'data', ['.thrift', '.capnp', '.avdl']),
  lang('config', 'Config', 'data', 'data', [
    '.json', '.jsonc', '.json5', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
    '.properties', '.xml', '.plist',
  ]),
  lang('hcl', 'HCL / Terraform', 'infra', 'infra', ['.tf', '.tfvars', '.hcl']),
  lang('nix', 'Nix', 'infra', 'infra', ['.nix']),
  // Filenames are matched case-insensitively, so `Makefile` covers `makefile`.
  // These three also have `tool` twins below: a Dockerfile has lines AND its
  // presence is a fact about the project. The language entry owns the lines; the
  // tool entry owns the presence. Neither is derived from the other.
  lang('makefile', 'Make', 'infra', 'infra', ['.mk'], ['Makefile', 'GNUmakefile']),
  lang('cmake', 'CMake', 'infra', 'infra', ['.cmake'], ['CMakeLists.txt']),
  lang('dockerfile', 'Dockerfile', 'infra', 'infra', ['.dockerfile'], ['Dockerfile', 'Containerfile']),
];

// ── frameworks, SDKs and manifest-detected tooling ────────────────────────────

const DEPENDENCY_ENTRIES = [
  // node — UI
  dep('react', 'framework', 'React', 'node', ['npm'], ['react', 'react-dom']),
  dep('next', 'framework', 'Next.js', 'node', ['npm'], ['next']),
  // `vue-framework` / `svelte-framework` / `astro-framework` rather than the bare
  // name: ids are unique across the whole registry, and the bare name already
  // belongs to the LANGUAGE entry that owns the `.vue` / `.svelte` / `.astro`
  // lines. Two entries, two questions — one counts lines, one states presence.
  dep('vue-framework', 'framework', 'Vue', 'node', ['npm'], ['vue']),
  dep('nuxt', 'framework', 'Nuxt', 'node', ['npm'], ['nuxt']),
  dep('svelte-framework', 'framework', 'Svelte', 'node', ['npm'], ['svelte']),
  dep('sveltekit', 'framework', 'SvelteKit', 'node', ['npm'], ['@sveltejs/kit']),
  dep('angular', 'framework', 'Angular', 'node', ['npm'], ['@angular/core']),
  dep('solid', 'framework', 'Solid', 'node', ['npm'], ['solid-js']),
  dep('preact', 'framework', 'Preact', 'node', ['npm'], ['preact']),
  dep('astro-framework', 'framework', 'Astro', 'node', ['npm'], ['astro']),
  dep('remix', 'framework', 'Remix', 'node', ['npm'], [], ['@remix-run/']),
  dep('tailwind', 'framework', 'Tailwind CSS', 'node', ['npm'], ['tailwindcss']),
  dep('mui', 'framework', 'MUI', 'node', ['npm'], [], ['@mui/']),
  dep('styled-components', 'framework', 'styled-components', 'node', ['npm'],
    ['styled-components'], ['@emotion/']),
  dep('redux', 'framework', 'Redux', 'node', ['npm'], ['redux', '@reduxjs/toolkit']),
  dep('zustand', 'framework', 'Zustand', 'node', ['npm'], ['zustand']),
  dep('tanstack-query', 'framework', 'TanStack Query', 'node', ['npm'], [], ['@tanstack/']),
  dep('d3', 'framework', 'D3', 'node', ['npm'], ['d3']),
  dep('three', 'framework', 'three.js', 'node', ['npm'], ['three']),
  // node — server
  dep('express', 'framework', 'Express', 'node', ['npm'], ['express']),
  dep('nest', 'framework', 'NestJS', 'node', ['npm'], ['@nestjs/core']),
  dep('fastify', 'framework', 'Fastify', 'node', ['npm'], ['fastify']),
  dep('koa', 'framework', 'Koa', 'node', ['npm'], ['koa']),
  dep('hono', 'framework', 'Hono', 'node', ['npm'], ['hono']),
  dep('socket-io', 'framework', 'Socket.IO', 'node', ['npm'], ['socket.io']),
  dep('graphql-js', 'framework', 'GraphQL', 'node', ['npm'], ['graphql'], ['@apollo/']),
  dep('prisma', 'framework', 'Prisma', 'node', ['npm'], ['prisma', '@prisma/client']),
  dep('drizzle', 'framework', 'Drizzle ORM', 'node', ['npm'], ['drizzle-orm', 'drizzle-kit']),
  dep('typeorm', 'framework', 'TypeORM', 'node', ['npm'], ['typeorm']),
  dep('sequelize', 'framework', 'Sequelize', 'node', ['npm'], ['sequelize']),
  dep('mongoose', 'framework', 'Mongoose', 'node', ['npm'], ['mongoose']),
  dep('knex', 'framework', 'Knex', 'node', ['npm'], ['knex', 'kysely']),
  // node — desktop / mobile
  dep('electron', 'framework', 'Electron', 'node', ['npm'], ['electron']),
  dep('tauri', 'framework', 'Tauri', 'node', ['npm', 'cargo'], ['tauri'], ['@tauri-apps/']),
  dep('react-native', 'framework', 'React Native', 'node', ['npm'], ['react-native']),
  dep('expo', 'framework', 'Expo', 'node', ['npm'], ['expo']),
  // node — build / test / lint (tools that happen to live in a manifest)
  dep('vite', 'tool', 'Vite', 'node', ['npm'], ['vite']),
  dep('webpack', 'tool', 'webpack', 'node', ['npm'], ['webpack']),
  dep('rollup', 'tool', 'Rollup', 'node', ['npm'], ['rollup']),
  dep('esbuild', 'tool', 'esbuild', 'node', ['npm'], ['esbuild']),
  dep('parcel', 'tool', 'Parcel', 'node', ['npm'], ['parcel']),
  dep('typescript-compiler', 'tool', 'TypeScript', 'node', ['npm'], ['typescript']),
  dep('vitest', 'tool', 'Vitest', 'node', ['npm'], ['vitest']),
  dep('jest', 'tool', 'Jest', 'node', ['npm'], ['jest', 'ts-jest']),
  dep('mocha', 'tool', 'Mocha', 'node', ['npm'], ['mocha', 'ava']),
  dep('playwright', 'tool', 'Playwright', 'node', ['npm'], ['playwright', '@playwright/test']),
  dep('cypress', 'tool', 'Cypress', 'node', ['npm'], ['cypress']),
  dep('testing-library', 'tool', 'Testing Library', 'node', ['npm'], [], ['@testing-library/']),
  dep('eslint', 'tool', 'ESLint', 'node', ['npm'], ['eslint']),
  dep('prettier', 'tool', 'Prettier', 'node', ['npm'], ['prettier']),
  dep('biome', 'tool', 'Biome', 'node', ['npm'], ['@biomejs/biome']),
  dep('turborepo', 'tool', 'Turborepo', 'node', ['npm'], ['turbo', 'nx', 'lerna']),

  // rust
  dep('tokio', 'framework', 'Tokio', 'rust', ['cargo'], ['tokio']),
  dep('axum', 'framework', 'Axum', 'rust', ['cargo'], ['axum']),
  dep('actix', 'framework', 'Actix Web', 'rust', ['cargo'], ['actix-web', 'actix']),
  dep('rocket', 'framework', 'Rocket', 'rust', ['cargo'], ['rocket']),
  dep('hyper', 'framework', 'Hyper / Tower', 'rust', ['cargo'], ['hyper', 'tower', 'warp']),
  dep('serde', 'framework', 'Serde', 'rust', ['cargo'], ['serde', 'serde_json']),
  dep('clap', 'framework', 'clap', 'rust', ['cargo'], ['clap']),
  dep('tracing', 'framework', 'tracing', 'rust', ['cargo'], ['tracing', 'anyhow', 'thiserror']),
  dep('bevy', 'framework', 'Bevy', 'gamedev', ['cargo'], ['bevy']),
  dep('wgpu', 'framework', 'wgpu / egui', 'gamedev', ['cargo'], ['wgpu', 'egui']),
  dep('sqlx', 'framework', 'SQLx', 'rust', ['cargo'], ['sqlx', 'diesel', 'sea-orm']),
  dep('polars', 'framework', 'Polars', 'data', ['cargo', 'python'], ['polars']),
  dep('candle', 'framework', 'Candle / Burn', 'ai', ['cargo'], ['candle-core', 'burn']),
  dep('wasm-bindgen', 'framework', 'wasm-bindgen', 'rust', ['cargo'], ['wasm-bindgen', 'wasm-pack']),
  dep('napi-rs', 'framework', 'napi-rs / PyO3', 'rust', ['cargo'], ['napi', 'pyo3', 'neon']),
  dep('rayon', 'framework', 'Rayon', 'rust', ['cargo'], ['rayon']),
  dep('criterion', 'tool', 'Criterion', 'rust', ['cargo'], ['criterion']),

  // go
  dep('gin', 'framework', 'Gin', 'go', ['gomod'], [], ['github.com/gin-gonic/gin']),
  dep('echo', 'framework', 'Echo', 'go', ['gomod'], [], ['github.com/labstack/echo']),
  dep('fiber', 'framework', 'Fiber', 'go', ['gomod'], [], ['github.com/gofiber/fiber']),
  dep('cobra', 'framework', 'Cobra', 'go', ['gomod'], [], ['github.com/spf13/cobra', 'github.com/spf13/viper']),
  dep('grpc-go', 'framework', 'gRPC', 'go', ['gomod'], [], ['google.golang.org/grpc']),
  dep('gorm', 'framework', 'GORM', 'go', ['gomod'], [], ['gorm.io/gorm']),
  dep('testify', 'tool', 'Testify', 'go', ['gomod'], [], ['github.com/stretchr/testify']),
  dep('client-go', 'sdk', 'Kubernetes client-go', 'infra', ['gomod'], [], ['k8s.io/client-go']),

  // python
  dep('django', 'framework', 'Django', 'python', ['python'], ['django']),
  dep('flask', 'framework', 'Flask', 'python', ['python'], ['flask']),
  dep('fastapi', 'framework', 'FastAPI', 'python', ['python'], ['fastapi', 'starlette']),
  dep('pydantic', 'framework', 'Pydantic', 'python', ['python'], ['pydantic']),
  dep('sqlalchemy', 'framework', 'SQLAlchemy', 'python', ['python'], ['sqlalchemy', 'alembic']),
  dep('celery', 'framework', 'Celery', 'python', ['python'], ['celery']),
  dep('uvicorn', 'framework', 'Uvicorn / Gunicorn', 'python', ['python'], ['uvicorn', 'gunicorn']),
  dep('requests', 'framework', 'requests / httpx', 'python', ['python'], ['requests', 'httpx']),
  dep('numpy', 'framework', 'NumPy', 'data', ['python'], ['numpy', 'scipy']),
  dep('pandas', 'framework', 'pandas', 'data', ['python'], ['pandas']),
  dep('scikit-learn', 'framework', 'scikit-learn', 'ai', ['python'], ['scikit-learn', 'matplotlib']),
  dep('pytorch', 'framework', 'PyTorch', 'ai', ['python'], ['torch', 'torchvision']),
  dep('tensorflow', 'framework', 'TensorFlow / JAX', 'ai', ['python'], ['tensorflow', 'jax']),
  dep('transformers', 'framework', 'Transformers', 'ai', ['python'], ['transformers']),
  dep('pytest', 'tool', 'pytest', 'python', ['python'], ['pytest']),
  dep('ruff', 'tool', 'Ruff', 'python', ['python'], ['ruff', 'black', 'mypy']),
  dep('boto3', 'sdk', 'AWS SDK (boto3)', 'infra', ['python'], ['boto3']),

  // jvm — maven coordinates and gradle strings alike
  dep('spring-boot', 'framework', 'Spring Boot', 'jvm', ['jvm'],
    ['org.springframework.boot'], ['spring-boot']),
  dep('quarkus', 'framework', 'Quarkus', 'jvm', ['jvm'], ['io.quarkus'], ['quarkus-']),
  dep('micronaut', 'framework', 'Micronaut', 'jvm', ['jvm'], ['io.micronaut'], ['micronaut-']),
  dep('ktor', 'framework', 'Ktor', 'jvm', ['jvm'], ['io.ktor'], ['ktor-']),
  dep('hibernate', 'framework', 'Hibernate', 'jvm', ['jvm'], [], ['org.hibernate', 'hibernate-']),
  dep('jackson', 'framework', 'Jackson', 'jvm', ['jvm'], [], ['com.fasterxml.jackson', 'jackson-']),
  dep('kotlin-coroutines', 'framework', 'Kotlin coroutines', 'jvm', ['jvm'], [], ['kotlinx-coroutines']),
  dep('junit', 'tool', 'JUnit', 'jvm', ['jvm'], ['junit', 'org.junit.jupiter'], ['junit-']),
  dep('mockito', 'tool', 'Mockito', 'jvm', ['jvm'], ['org.mockito'], ['mockito-']),

  // other ecosystems
  dep('flutter', 'framework', 'Flutter', 'mobile', ['pub'], ['flutter']),
  dep('riverpod', 'framework', 'Riverpod / Bloc', 'mobile', ['pub'], ['riverpod', 'flutter_bloc', 'bloc']),
  dep('dio', 'framework', 'Dio', 'mobile', ['pub'], ['dio']),
  dep('phoenix', 'framework', 'Phoenix', 'beam', ['hex'], ['phoenix', 'phoenix_live_view']),
  dep('ecto', 'framework', 'Ecto', 'beam', ['hex'], ['ecto', 'ecto_sql', 'plug']),
  dep('absinthe', 'framework', 'Absinthe', 'beam', ['hex'], ['absinthe']),
  dep('nx', 'framework', 'Nx', 'ai', ['hex'], ['nx', 'axon']),
  dep('laravel', 'framework', 'Laravel', 'php', ['composer'], ['laravel/framework']),
  dep('symfony', 'framework', 'Symfony', 'php', ['composer'], [], ['symfony/']),
  dep('guzzle', 'framework', 'Guzzle', 'php', ['composer'], ['guzzlehttp/guzzle']),
  dep('phpunit', 'tool', 'PHPUnit', 'php', ['composer'], ['phpunit/phpunit']),
  dep('rails', 'framework', 'Rails', 'ruby', ['rubygems'], ['rails', 'railties']),
  dep('sinatra', 'framework', 'Sinatra', 'ruby', ['rubygems'], ['sinatra']),
  dep('sidekiq', 'framework', 'Sidekiq / Puma', 'ruby', ['rubygems'], ['sidekiq', 'puma']),
  dep('rspec', 'tool', 'RSpec', 'ruby', ['rubygems'], ['rspec', 'rspec-rails', 'rubocop']),

  // AI SDKs — the reason half of these projects exist, so they are named, not
  // folded into a generic "http client" bucket.
  dep('anthropic-sdk', 'sdk', 'Anthropic SDK', 'ai', ['npm', 'python'],
    ['@anthropic-ai/sdk', 'anthropic']),
  dep('openai-sdk', 'sdk', 'OpenAI SDK', 'ai', ['npm', 'python'], ['openai']),
  dep('google-genai-sdk', 'sdk', 'Google GenAI SDK', 'ai', ['npm', 'python'],
    ['@google/generative-ai', 'google-generativeai', '@google/genai']),
  dep('langchain', 'sdk', 'LangChain', 'ai', ['npm', 'python'],
    ['langchain', 'langgraph'], ['@langchain/', 'langchain-']),
  dep('llamaindex', 'sdk', 'LlamaIndex', 'ai', ['npm', 'python'], ['llamaindex', 'llama-index']),
  dep('vercel-ai-sdk', 'sdk', 'Vercel AI SDK', 'ai', ['npm'], ['ai'], ['@ai-sdk/']),
  dep('mcp-sdk', 'sdk', 'Model Context Protocol', 'ai', ['npm', 'python'],
    ['mcp', 'fastmcp'], ['@modelcontextprotocol/']),
  dep('ollama', 'sdk', 'Ollama', 'ai', ['npm', 'python'], ['ollama']),
  dep('ruflo', 'sdk', 'ruflo / claude-flow', 'ai', ['npm'],
    ['claude-flow', 'ruflo', '@claude-flow/cli'], ['@ruvector/']),
];

// ── file / directory signatures ───────────────────────────────────────────────

const SIGNATURE_ENTRIES = [
  sig('docker', 'Docker', 'infra', {
    files: ['dockerfile', 'containerfile', '.dockerignore'],
    filePrefixes: ['dockerfile.'],
  }),
  sig('docker-compose', 'Docker Compose', 'infra', {
    filePrefixes: ['docker-compose', 'compose.yml', 'compose.yaml'],
  }),
  sig('github-actions', 'GitHub Actions', 'infra', { dirs: ['.github/workflows'] }),
  sig('gitlab-ci', 'GitLab CI', 'infra', { files: ['.gitlab-ci.yml'] }),
  sig('circleci', 'CircleCI', 'infra', { dirs: ['.circleci'] }),
  sig('terraform', 'Terraform', 'infra', {
    files: ['main.tf', 'versions.tf', 'terraform.tf'],
    dirs: ['.terraform'],
  }),
  sig('kubernetes', 'Kubernetes / Helm', 'infra', {
    files: ['chart.yaml', 'kustomization.yaml', 'skaffold.yaml'],
    dirs: ['k8s', 'kubernetes', 'charts'],
  }),
  sig('serverless', 'Serverless / SAM', 'infra', { files: ['serverless.yml', 'template.yaml'] }),
  sig('vercel', 'Vercel / Netlify', 'infra', { files: ['vercel.json', 'netlify.toml'] }),
  sig('nix-flake', 'Nix', 'infra', { files: ['flake.nix', 'shell.nix', 'default.nix'] }),
  sig('devcontainer', 'Dev Container', 'infra', { dirs: ['.devcontainer'] }),
  sig('direnv', 'direnv', 'shell', { files: ['.envrc'] }),
  sig('make', 'Make', 'infra', { files: ['makefile', 'gnumakefile'] }),
  sig('just', 'just', 'infra', { files: ['justfile', '.justfile'] }),
  sig('taskfile', 'Task', 'infra', { files: ['taskfile.yml', 'taskfile.yaml'] }),
  sig('cmake-build', 'CMake', 'infra', { files: ['cmakelists.txt'] }),
  sig('eslint-config', 'ESLint', 'node', { filePrefixes: ['.eslintrc', 'eslint.config.'] }),
  sig('prettier-config', 'Prettier', 'node', { filePrefixes: ['.prettierrc', 'prettier.config.'] }),
  sig('tsconfig', 'TypeScript config', 'node', {
    files: ['tsconfig.json'], filePrefixes: ['tsconfig.'],
  }),
  sig('pre-commit', 'pre-commit', 'infra', { files: ['.pre-commit-config.yaml'] }),
  sig('husky', 'husky / lint-staged', 'node', { dirs: ['.husky'] }),
  sig('changesets', 'Changesets', 'node', { dirs: ['.changeset'] }),
  sig('editorconfig', 'EditorConfig', 'infra', { files: ['.editorconfig'] }),
  sig('dependabot', 'Dependabot / Renovate', 'infra', {
    files: ['renovate.json', '.renovaterc', '.github/dependabot.yml'],
  }),
  sig('claude-code-config', 'Claude Code config', 'ai', {
    files: ['claude.md', 'claude.local.md'], dirs: ['.claude'],
  }),
  sig('agents-md', 'AGENTS.md', 'ai', { files: ['agents.md'] }),
  sig('ruflo-state', 'ruflo state', 'ai', { dirs: ['.claude-flow', '.swarm', '.hive-mind'] }),
  sig('agentic-qe-state', 'agentic-qe state', 'ai', { dirs: ['.agentic-qe'] }),
  sig('codex-config', 'Codex config', 'ai', { dirs: ['.codex'] }),
  sig('opencode-config', 'OpenCode config', 'ai', {
    files: ['opencode.json', 'opencode.jsonc'], dirs: ['.opencode'],
  }),
];

// ── the deliberate non-source list ────────────────────────────────────────────
//
// Extensions we have LOOKED AT and decided hold bytes, not lines. This is what
// separates a decision from an oversight: an extension here is a stated exclusion
// the surfaces can name, while an extension in neither list is an unrecognized
// tail row — a to-do the next release can close. Without this split the tail fills
// with .png and .sqlite and stops being a to-do list at all.
//
// `.svg` is the judgement call in this list. Hand-authored SVG really is source,
// but most SVG on a machine is exported by a tool, and letting generated art into
// a line count would quietly inflate every project that ships icons. Recorded here
// as a reviewable decision rather than left to chance.
export const NON_SOURCE_EXTENSIONS = Object.freeze([
  // images, media, fonts
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff',
  '.svg', '.psd', '.ai', '.mp4', '.mov', '.webm', '.avi', '.mkv', '.mp3', '.wav',
  '.ogg', '.flac', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // archives and packages
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar', '.dmg', '.iso',
  '.deb', '.rpm', '.apk', '.ipa', '.pkg', '.whl', '.crate', '.nupkg',
  // compiled and linked artefacts
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.lib', '.bin', '.wasm',
  '.class', '.jar', '.war', '.ear', '.pyc', '.pyo', '.pyd', '.node', '.rlib',
  '.rmeta', '.pdb', '.d', '.map',
  // stores, indexes and model weights
  '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3', '.sqlite-wal', '.sqlite-shm',
  '.mdb', '.mmdb', '.rvf', '.hnsw', '.idx', '.index', '.pack', '.parquet', '.arrow',
  '.feather', '.npy', '.npz', '.pt', '.pth', '.onnx', '.safetensors', '.gguf', '.ggml',
  // records, dumps and scratch
  '.log', '.jsonl', '.ndjson', '.csv', '.tsv', '.txt', '.pdf', '.docx', '.xlsx',
  '.pptx', '.lock', '.bak', '.backup', '.tmp', '.swp', '.part', '.pid', '.sock',
  '.pem', '.key', '.crt', '.cer', '.p12', '.der',
  // tool output that happens to be text: a report is not a line someone wrote
  '.sarif', '.excalidraw', '.snap',
]);

const nonSource = new Set(NON_SOURCE_EXTENSIONS);

/** Is this extension a stated non-source exclusion (as opposed to something the
 *  registry has simply never been taught)? The distinction is the whole point of
 *  the unrecognized tail. */
export function isNonSourceExtension(ext) {
  return nonSource.has(String(ext ?? '').toLowerCase());
}

/** The whole catalog, frozen. Order is language → dependency → signature so a
 *  consumer that renders the registry itself gets a stable reading order. */
export const STACK_REGISTRY = Object.freeze([
  ...LANGUAGE_ENTRIES, ...DEPENDENCY_ENTRIES, ...SIGNATURE_ENTRIES,
]);

// ── indices ───────────────────────────────────────────────────────────────────
//
// Built once at import from the frozen data above — pure computation, no I/O.
// Every index is FIRST-WINS on a collision and records what it dropped in
// REGISTRY_CONFLICTS, so an accidental duplicate is a visible, testable fact
// rather than a silently shadowed entry.

/** Collisions found while indexing. Empty in a healthy registry; a unit test
 *  asserts that, which is what keeps this a curated artifact rather than a pile. */
export const REGISTRY_CONFLICTS = [];

const byId = new Map();
const byExtension = new Map();
const byFilename = new Map();
const byDependency = new Map(); // `${manifest} ${name}` and prefix list per manifest
const prefixesByManifest = new Map();

const claim = (map, key, entry, scope) => {
  const held = map.get(key);
  if (held) {
    REGISTRY_CONFLICTS.push({ scope, key, keptId: held.id, droppedId: entry.id });
    return;
  }
  map.set(key, entry);
};

for (const entry of STACK_REGISTRY) {
  claim(byId, entry.id, entry, 'id');
  if (entry.match.by === 'extension') {
    for (const ext of entry.match.extensions) claim(byExtension, ext, entry, 'extension');
    for (const name of entry.match.filenames) claim(byFilename, name, entry, 'filename');
  } else if (entry.match.by === 'dependency') {
    for (const manifest of entry.match.manifests) {
      for (const name of entry.match.names) {
        claim(byDependency, `${manifest} ${name}`, entry, 'dependency');
      }
      if (entry.match.prefixes.length) {
        if (!prefixesByManifest.has(manifest)) prefixesByManifest.set(manifest, []);
        for (const prefix of entry.match.prefixes) {
          prefixesByManifest.get(manifest).push({ prefix, entry });
        }
      }
    }
  }
}
// Longest prefix first, so `@langchain/` never loses to a shorter neighbour.
for (const list of prefixesByManifest.values()) list.sort((a, b) => b.prefix.length - a.prefix.length);
// An extension cannot be both a counted language and a stated non-source
// exclusion; whichever way that got decided it was decided twice.
for (const ext of NON_SOURCE_EXTENSIONS) {
  const held = byExtension.get(ext);
  if (held) REGISTRY_CONFLICTS.push({ scope: 'non-source', key: ext, keptId: held.id, droppedId: 'non-source' });
}
Object.freeze(REGISTRY_CONFLICTS);

// ── accessors ─────────────────────────────────────────────────────────────────

/** Every entry, or every entry of one kind. Returns a fresh array; the entries
 *  themselves are frozen. */
export function stackEntries(kind = null) {
  return kind ? STACK_REGISTRY.filter((entry) => entry.kind === kind) : [...STACK_REGISTRY];
}

/** One entry by id, or null. Ids are globally unique across kinds. */
export function stackEntryById(id) {
  return byId.get(String(id ?? '')) ?? null;
}

/** The language that owns a file extension (leading dot, any case), or null.
 *  Null is the answer that matters: it means "not counted", not "zero lines". */
export function languageForExtension(ext) {
  return byExtension.get(String(ext ?? '').toLowerCase()) ?? null;
}

/** The language that owns a bare filename (`Makefile`, `Dockerfile`), or null. */
export function languageForFilename(name) {
  return byFilename.get(String(name ?? '').toLowerCase()) ?? null;
}

/** The manifest family a filename belongs to, or null. `requirements-dev.txt` and
 *  friends are matched by shape because the suffix is convention, not spec. */
export function manifestKindFor(filename) {
  const name = String(filename ?? '').toLowerCase();
  const exact = MANIFEST_FILES[name];
  if (exact) return exact;
  return /^requirements[\w.-]*\.txt$/.test(name) ? 'python' : null;
}

/** The registry entry a dependency name resolves to inside one manifest family,
 *  or null — which is exactly what makes it part of the unrecognized tail. */
export function dependencyEntry(manifestKind, depName) {
  const name = String(depName ?? '').toLowerCase();
  if (!name) return null;
  const exact = byDependency.get(`${manifestKind} ${name}`);
  if (exact) return exact;
  for (const { prefix, entry } of prefixesByManifest.get(manifestKind) ?? []) {
    if (name.startsWith(prefix)) return entry;
  }
  return null;
}

/**
 * Every signature entry, for the caller that matches collected paths in one pass.
 *
 * @returns {Array<{ id: string, kind: string, name: string, ecosystem: string,
 *   match: { by: string, files: string[], dirs: string[], filePrefixes: string[] } }>}
 */
export function signatureEntries() {
  return /** @type {any} */ (STACK_REGISTRY.filter((entry) => entry.match.by === 'signature'));
}

/** The one-line provenance a panel prints next to a changed number: which
 *  registry produced it and how wide that registry is. */
export function registryStats() {
  const counts = { language: 0, framework: 0, sdk: 0, tool: 0 };
  for (const entry of STACK_REGISTRY) counts[entry.kind] += 1;
  return Object.freeze({
    version: STACK_REGISTRY_VERSION,
    entries: STACK_REGISTRY.length,
    languages: counts.language,
    frameworks: counts.framework,
    sdks: counts.sdk,
    tools: counts.tool,
    extensions: byExtension.size,
    filenames: byFilename.size,
    nonSourceExtensions: NON_SOURCE_EXTENSIONS.length,
    manifestKinds: MANIFEST_KINDS.length,
  });
}
