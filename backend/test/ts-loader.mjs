import * as moduleApi from 'node:module';

const regFn = moduleApi.registerHooks;
if (typeof regFn === 'function') {
  regFn({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          return nextResolve(`${specifier}.ts`, context);
        }
        throw err;
      }
    },
  });
}
