/**
 * @fileoverview Processes Markdown files for consumption by ESLint.
 * @author Brandon Mills
 */

/**
 * @typedef {import('eslint/lib/shared/types').LintMessage} Message
 *
 * @typedef {Object} ASTNode
 * @property {string} type
 * @property {string} [lang]
 *
 * @typedef {Object} RangeMap
 * @property {number} indent Number of code block indent characters trimmed from
 *     the beginning of the line during extraction.
 * @property {number} js Offset from the start of the code block's range in the
 *     extracted JS.
 * @property {number} md Offset from the start of the code block's range in the
 *     original Markdown.
 *
 * @typedef {Object} BlockBase
 * @property {string} baseIndentText
 * @property {string[]} comments
 * @property {RangeMap[]} rangeMap
 *
 * @typedef {ASTNode & BlockBase} Block
 */

"use strict";

const parseMarkdown = require("mdast-util-from-markdown");
const SourceMap = require("./source-map");

const UNSATISFIABLE_RULES = [
    "eol-last", // The Markdown parser strips trailing newlines in code fences
    "unicode-bom" // Code blocks will begin in the middle of Markdown files
];

function* enumerateNodes(node) {
    yield node;

    if (node.children) {
        for (const child of node.children) {
            yield* enumerateNodes(child);
        }
    }
}

class Directives {
    static #commentRegex = /^(?<prefix><!--\s*)(?<directive>eslint\b.+?|global\s.+?)(?<postfix>\s*-->)$/u;

    #directives = [];
    #ignoreBlock = false;

    /**
     * Extracts `eslint-*` or `global` comments from HTML comments if present.
     * @param {string} htmlNode The HTML AST node.
     * @returns {Object|null} The extracted directive or null if the comment is not a directive.
     */
    static #extractDirective(htmlNode) {
        const match = Directives.#commentRegex.exec(htmlNode.value);

        if (!match) {
            return null;
        }

        const start = htmlNode.position.start;
        const end = htmlNode.position.end;
        const { prefix, directive, postfix } = match.groups;

        return {
            directive: directive,
            location: {
                start: { line: start.line, column: start.column + prefix.length - 1 },
                end: { line: end.line, column: end.column - postfix.length - 1 }
            }
        };
    }

    add(htmlNode) {
            const directive = Directives.#extractDirective(htmlNode);

            if (!directive) {
                this.clear();
            } else if (directive.directive === "eslint-skip") {
                this.#ignoreBlock = true;
                this.#directives.length = 0;
            } else if (!this.#ignoreBlock) {
                this.#directives.push(directive);
            }
        }

    clear() {
        this.#directives.length = 0;
        this.#ignoreBlock = false;
    }

    consume() {
        const result = this.#directives.slice();

        this.clear();

        return result;
    }
};

// Before a code block, blockquote characters (`>`) are also considered
// "whitespace".
const leadingWhitespaceRegex = /^[>\s]*/u;

/**
 * Gets the leading text, typically whitespace with possible blockquote chars,
 * used to indent a code block.
 * @param {string} text The text of the file.
 * @param {ASTNode} node A Markdown code block AST node.
 * @returns {string} The text from the start of the first line to the opening
 *     fence of the code block.
 */
function getBaseIndent(text, node) {
    if (node.position.start.column === 1) {
        return 0;
    }

    const leadingTextBeforeBackTicks = text.slice(
        node.position.start.offset - node.position.start.column + 1,
        node.position.start.offset
    );

    const match = leadingWhitespaceRegex.exec(leadingTextBeforeBackTicks);
    return match
        ? match[0].length
        : 0;
}

function generateMap(fileName, generatedFileName, text, node, directives) {

    const sourceMap = new SourceMap(fileName, text, generatedFileName);

    const directiveLine = 1;
    for (const { directive, position: { start, end }} of directives) {
        const isMultiline = start.line !== end.line;
        const generatedPosition = {
            start: { line: directiveLine, column: 3 },
            end: isMultiline
                ? { line: directiveLine + (end.line - start.line), column: end.column }
                : { line: directiveLine, column: 3 + (end.column - start.column) }
        };
        sourceMap.addMapping(directive.position, generatedPosition);
    }

    const baseIndent = getBaseIndent(text, node);

    const mappedLines = text.slice(node.position.start.offset, node.position.end.offset)
        .split(/\r\n|\n|\r/g)
        .slice(1, -1) // Remove the opening and closing fences.
        .map(line => line.slice(baseIndent));

    for (const codeLine = 0; codeLine < mappedLines.length; codeLine++) {
        const generatedCodeLine = directiveLine + codeLine + 1;
        sourceMap.addMapping({
            original: {
                start: { line: (node.position.start.line + 1 + codeLine), column: baseIndent + 1 },
                end:   { line: (node.position.start.line + 1 + codeLine), column: baseIndent + line.length + 1 }
            },
            generated: {
                start: { line: generatedCodeLine, column: 1 },
                end:   { line: generatedCodeLine, column: line.length + 1 }
            }
        });
    }

    const generatedSource = [...directives.map(d => `/* ${d.directive} */`), ...mappedLines].join('\n');
    return { sourceMap, generatedSource };
}

const sourceMaps = (() => {

    const store = new Map();

    return {
        add(fileName, sourceMap) {
            const sourceMaps = store.get(fileName) || [];
            sourceMaps.push(sourceMap);
            store.set(fileName, sourceMaps);
        },

        get(fileName, index) {
            const sourceMaps = store.get(fileName);
            return sourceMaps[index];
        }
    };
})();

/**
 * Extracts lintable code blocks from Markdown text.
 * @param {string} text The text of the file.
 * @param {string} filename The filename of the file
 * @returns {Array<{ filename: string, text: string }>} Source code blocks to lint.
 */
function preprocess(text, filename) {

    const ast = parseMarkdown(text);
    const directives = new Directives();
    const subFiles = [];

    for (const node of enumerateNodes(ast)) {
        if (node.type === "html") {

            directives.add(node);

        } else if (node.type === "code" && node.lang) {

            try {
            const generatedFileName = `${subFiles.length}.${node.lang.trim().split(" ")[0]}`;
            const { generatedSource, sourceMap } = generateMap(filename, generatedFileName, text, node, directives.consume());
            sourceMaps.add(filename, sourceMap);
            subFiles.push({
                filename: generatedFileName,
                text: generatedSource
            });

            /*fs.mkdirSync(`.generated/${path.basename(filename)}`, { recursive: true });
            fs.writeFileSync(`.generated/${path.basename(filename)}/${generatedFileName}`, generatedSource + `\r\n//# sourceMappingURL=${generatedFileName}.map`);
            fs.writeFileSync(`.generated/${path.basename(filename)}/${generatedFileName}.map`, sourceMap.toString());*/
            } catch (e) {
                debugger;
            }

        } else {

            directives.clear();

        }
    }

    return subFiles;
}

/**
 * Excludes unsatisfiable rules from the list of messages.
 * @param {Message} message A message from the linter.
 * @returns {boolean} True if the message should be included in output.
 */
function excludeUnsatisfiableRules(message) {
    return message && UNSATISFIABLE_RULES.indexOf(message.ruleId) < 0;
}

/**
 * Transforms generated messages for output.
 * @param {Array<Message[]>} messages An array containing one array of messages
 *     for each code block returned from `preprocess`.
 * @param {string} filename The filename of the file
 * @returns {Message[]} A flattened array of messages with mapped locations.
 */
function postprocess(messages, filename) {

    return messages.flatMap((blockMessages, blockIndex) => {

        const sourceMap = sourceMaps.get(filename, blockIndex);
        return blockMessages
            .filter(excludeUnsatisfiableRules)
            .map(message => {
                const startPosition = sourceMap.originalPositionFor({ line: message.line, column: message.column + 1 });
                const endPosition = sourceMap.originalPositionFor({ line: message.endLine, column: message.endColumn + 1 });
                const canFix = startPosition.line === endPosition.line; // We can't really resolve cross-line fixes, but on one line, sure!

                return {
                    ...message,
                    line: startPosition.line,
                    column: startPosition.column + 1,
                    endLine: endPosition.line,
                    endColumn: endPosition.column + 1,
                    fix: canFix ? message.fix : undefined,
                    suggestions: message.suggestions?.map(suggestion => ({ ...suggestion, fix: canFix ? suggestion.fix : undefined }))
                };
            });
    });
}

module.exports = {
    preprocess,
    postprocess,
    supportsAutofix: true
};
