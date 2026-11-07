import { getContext } from '../../../extensions.js';
import { getRegexScripts } from '../../regex/engine.js';
import { createExtension } from './src/extension.js?v=1.0.2';

const extension = createExtension({ getContext, getRegexScripts });
extension.start();

export async function onDisable() {
  await extension.dispose();
}
