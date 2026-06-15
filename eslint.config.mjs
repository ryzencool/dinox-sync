import obsidianmd from "eslint-plugin-obsidianmd";

const typedObsidianRulesOff = {
	"obsidianmd/no-plugin-as-component": "off",
	"obsidianmd/no-view-references-in-plugin": "off",
	"obsidianmd/no-unsupported-api": "off",
	"obsidianmd/prefer-instanceof": "off",
	"obsidianmd/prefer-file-manager-trash-file": "off",
};

export default [
	{
		ignores: ["main.js", "eslint.config.mjs", "esbuild.config.mjs", "version-bump.mjs"],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ["package.json"],
		rules: typedObsidianRulesOff,
	},
];
