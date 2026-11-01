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
		// Obsidian's community-directory review reports these; the recommended
		// preset turns them off, so re-enable them to catch issues locally.
		rules: {
			"@typescript-eslint/no-unsafe-argument": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-return": "error",
		},
	},
	{
		files: ["package.json"],
		rules: typedObsidianRulesOff,
	},
];
