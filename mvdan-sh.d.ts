/**
 * Types for `mvdan-sh`, which ships none: it is a GopherJS build of mvdan/sh
 * and its `index.js` is generated.
 *
 * Only the surface `shell-ast.ts` uses is declared, so this file doubles as the
 * statement of what this repository depends on. The AST nodes themselves stay
 * `unknown`: their shape is read through `NodeType` and field access inside
 * `shell-ast.ts`, and pretending to type them here would be a second, unchecked
 * copy of the Go structs.
 */
declare module "mvdan-sh" {
	export interface ParserOption {
		readonly __parserOption: unique symbol;
	}

	export interface Parser {
		/** Throws a Go error value on a syntax error: `Text` carries the
		 *  message, `Error()` the message with its position. */
		Parse(source: string, name: string): unknown;
	}

	export interface Syntax {
		NewParser(...options: ParserOption[]): Parser;
		Variant(language: unknown): ParserOption;
		KeepComments(keep: boolean): ParserOption;
		LangBash: unknown;
		LangPOSIX: unknown;
		LangMirBSDKorn: unknown;
		/** The node's Go type name, such as `CallExpr` or `Redirect`. Throws on
		 *  a value that is not a node. */
		NodeType(node: unknown): string;
		/** Depth-first walk. Returning false stops the descent. */
		Walk(node: unknown, visit: (node: unknown) => boolean): void;
	}

	const sh: { syntax: Syntax };
	export default sh;
}
