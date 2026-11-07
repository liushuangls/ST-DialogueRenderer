import { getContext } from '../../../extensions.js';
import { getRegexScripts } from '../../regex/engine.js';
import { createExtension } from './src/extension.js';

const extension = createExtension({ getContext, getRegexScripts });
extension.start();

export async function onDisable() {
  await extension.dispose();
}
