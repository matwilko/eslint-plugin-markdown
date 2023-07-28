"use strict";

const { SourceMapGenerator } = require("source-map");
const { SourceMapConsumer } = require("@cspotcode/source-map-consumer");

const fs = require('node:fs');
const path = require('node:path');


class SourceMap {

    #sourceFileName;
    #generator;
    #consumer;

    constructor(sourceFileName, originalSource, generatedFileName) {
        this.#sourceFileName = sourceFileName;
        this.#generator = new SourceMapGenerator(generatedFileName);
        this.#generator.setSourceContent(sourceFileName, originalSource);
    }

    addMapping(originalRange, generatedRange) {
        if (this.#consumer) throw new Error("Cannot add mappings after consumer has been initialized.");

        // Add a mapping from the start of range
        this.#generator.addMapping({
            source: this.#sourceFileName,
            original: originalRange.start,
            generated: generatedRange.start
        });

        // And now add a null mapping from the end of
        // the generated range so that the parts after
        // the range aren't mapped to the original
        this.#generator.addMapping({
            generated: generatedRange.end
        });
    }

    #intializeConsumer() {
        if (this.#consumer) return;

        const generatedSourceMap = this.#generator.toString();
        this.#consumer = new SourceMapConsumer(generatedSourceMap);
    }

    mapPosition(generatedPosition) {
        this.#intializeConsumer();

        const originalPosition = this.#consumer.originalPositionFor(generatedPosition);
        return originalPosition;
    }
}

module.exports = SourceMap;
