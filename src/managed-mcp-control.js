'use strict';

// One runtime per core process. Configuration reload belongs to runtime.reload;
// replacing a live runtime would strand session grants and admitted calls.
let runtime = null;
function installManagedRuntime(value) {
  if (runtime && value !== runtime) throw new Error('Managed runtime already installed');
  if (!value || typeof value.bindSession !== 'function' || typeof value.invokeAction !== 'function') throw new Error('Invalid managed runtime');
  runtime = value;
}
module.exports = { installManagedRuntime, getManagedRuntime: () => runtime };
