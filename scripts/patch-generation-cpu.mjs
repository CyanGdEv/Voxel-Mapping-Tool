import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../.github/workflows/generate-themepark.yml', import.meta.url);
let source = await readFile(path, 'utf8');

const oldRunner = `  generate:\n    needs: [planning-plan, planning-extract]\n    runs-on: ubuntu-24.04`;
const newRunner = `  generate:\n    needs: [planning-plan, planning-extract]\n    # Set TPMAP_GENERATION_RUNNER to a configured larger-runner label (8/16+ cores)\n    # without changing this workflow. Falls back to the standard hosted runner.\n    runs-on: \${{ vars.TPMAP_GENERATION_RUNNER || 'ubuntu-24.04' }}`;
if (!source.includes(newRunner)) {
  if (!source.includes(oldRunner)) throw new Error('Generate runner marker not found');
  source = source.replace(oldRunner, newRunner);
}

const setupMarker = `      - name: Set up Node.js\n        uses: actions/setup-node@v6\n        with:\n          node-version: 22\n          cache: npm\n`;
const cpuStep = `\n      - name: Configure full-runner CPU parallelism\n        shell: bash\n        run: |\n          set -euo pipefail\n          cores="$(nproc)"\n          libuv="$cores"\n          if [ "$libuv" -gt 128 ]; then libuv=128; fi\n          {\n            echo "TPMAP_CPU_WORKERS=$cores"\n            echo "UV_THREADPOOL_SIZE=$libuv"\n            echo "GDAL_NUM_THREADS=ALL_CPUS"\n            echo "OMP_NUM_THREADS=$cores"\n            echo "OMP_THREAD_LIMIT=$cores"\n            echo "OPENBLAS_NUM_THREADS=$cores"\n            echo "MKL_NUM_THREADS=$cores"\n            echo "NUMEXPR_NUM_THREADS=$cores"\n            echo "OPENCV_FOR_THREADS_NUM=$cores"\n          } >> "$GITHUB_ENV"\n          echo "Generator CPU budget: $cores logical cores (libuv=$libuv)"\n          lscpu | sed -n '1,18p'\n`;
if (!source.includes('name: Configure full-runner CPU parallelism')) {
  const generateIndex = source.indexOf('  generate:');
  const setupIndex = source.indexOf(setupMarker, generateIndex);
  if (setupIndex < 0) throw new Error('Generate Node setup marker not found');
  const insertAt = setupIndex + setupMarker.length;
  source = source.slice(0, insertAt) + cpuStep + source.slice(insertAt);
}

const buildMarker = `      - name: Automatically discover planning evidence and build Bedrock world\n        shell: bash\n        run: |\n          set -euo pipefail\n`;
const buildReplacement = `      - name: Automatically discover planning evidence and build Bedrock world\n        shell: bash\n        run: |\n          set -euo pipefail\n          echo "Building with TPMAP_CPU_WORKERS=$TPMAP_CPU_WORKERS, UV_THREADPOOL_SIZE=$UV_THREADPOOL_SIZE, GDAL_NUM_THREADS=$GDAL_NUM_THREADS"\n`;
if (!source.includes('Building with TPMAP_CPU_WORKERS=')) {
  if (!source.includes(buildMarker)) throw new Error('Build marker not found');
  source = source.replace(buildMarker, buildReplacement);
}

for (const marker of [
  "vars.TPMAP_GENERATION_RUNNER || 'ubuntu-24.04'",
  'TPMAP_CPU_WORKERS=$cores',
  'UV_THREADPOOL_SIZE=$libuv',
  'GDAL_NUM_THREADS=ALL_CPUS',
  'OMP_NUM_THREADS=$cores',
  'OPENCV_FOR_THREADS_NUM=$cores',
  'Building with TPMAP_CPU_WORKERS='
]) {
  if (!source.includes(marker)) throw new Error(`Missing CPU integration marker: ${marker}`);
}

await writeFile(path, source);
console.log('Applied full-runner CPU parallelism configuration');
