import { parentPort, workerData } from 'node:worker_threads';
import { Ajv } from 'ajv';
try {
  const ajv = new Ajv({ strict: true, allErrors: true, validateFormats: false });
  const validate = ajv.compile(workerData.schema);
  const valid = validate(workerData.output);
  parentPort?.postMessage({ valid, detail: valid ? 'schema passed' : ajv.errorsText(validate.errors).slice(0, 1000) });
} catch { parentPort?.postMessage({ valid: false, detail: 'schema unsupported or invalid' }); }
