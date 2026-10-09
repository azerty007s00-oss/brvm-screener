import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Le prefixe _ marque un parametre volontairement inutilise : useActionState
      // impose une signature (etatPrecedent, donnees) que toutes les actions ne
      // consomment pas entierement.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    /*
     * Les ateliers des controles : du code recopie et compile, efface a la fin.
     * Un controle qui echoue les laisse derriere lui, et le linter se mettait
     * alors a rapporter des avertissements sur du code genere.
     */
    ".verif/**",
    ".lettre/**",
    ".lettre-js/**",
    ".reglements/**",
    ".reglements-js/**",
  ]),
]);

export default eslintConfig;
