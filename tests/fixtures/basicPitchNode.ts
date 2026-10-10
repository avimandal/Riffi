import * as tf from '@tensorflow/tfjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Load the Basic Pitch model from disk for tests (tfjs CPU backend). */
export async function loadBasicPitchModel(): Promise<tf.GraphModel> {
  const dir = join(process.cwd(), 'node_modules', '@spotify', 'basic-pitch', 'model');
  const json = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));
  const bin = readFileSync(join(dir, 'group1-shard1of1.bin'));
  const weightData = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  return tf.loadGraphModel(
    tf.io.fromMemory({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest[0].weights,
      weightData,
      format: json.format,
      generatedBy: json.generatedBy,
      convertedBy: json.convertedBy,
    }),
  );
}

export { tf };
