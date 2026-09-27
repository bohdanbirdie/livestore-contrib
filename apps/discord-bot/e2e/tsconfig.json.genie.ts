import { packageTsconfigExclude } from '../../../genie/repo.ts'
import { tsconfigJson } from '../../../repos/effect-utils/genie/external.ts'
import { discordBotCompilerOptions } from '../tsconfig.json.genie.ts'

export default tsconfigJson({
  compilerOptions: {
    ...discordBotCompilerOptions,
    rootDir: '..',
    // The live runner executes these sources with Node's type stripping, which rejects
    // non-erasable syntax such as constructor parameter properties.
    erasableSyntaxOnly: true,
    types: ['node', 'vitest/globals'],
  },
  include: ['src/**/*.ts'],
  exclude: [...packageTsconfigExclude],
})
