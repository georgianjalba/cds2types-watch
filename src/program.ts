import _ from "lodash";
import cds from "@sap/cds";
import * as fs from "fs-extra";
import * as morph from "ts-morph";
import * as path from "path";
import chokidar from "chokidar";

import { IOptions, IParsed } from "./utils/types";
import { replaceExt } from "./utils/file.utils";
import { CDSParser } from "./cds.parser";
import { ICsn } from "./utils/cds.types";
import { Namespace } from "./types/namespace";
import { Formatter } from "./formatter/formatter";
import { NoopFormatter } from "./formatter/noop.formatter";
import { PrettierFormatter } from "./formatter/prettier.formatter";

/**
 * Main porgram class.
 *
 * @export
 * @class Program
 */
export class Program {
    /**
     * Main method.
     *
     * @param {Command} options Parsed CLI options.
     * @memberof Program
     */
    public async run(options: IOptions): Promise<void> {
        if (options.folder) {
            await this.processFiles(options);
        } else {
            await this.processFile(options);
        }

        this.createWatcher(options);
    }

    /**
     * Process files in the configured folder
     *
     * @param options Parsed CLI options.
     * @memberof Program
     */
    private async processFiles(options: IOptions) {
        const filesToConvert = fs.readdirSync(options.folder);

        // Convert existing files in the folder
        for (const filePath of filesToConvert) {
            if (path.extname(filePath) === ".cds") {
                const newOptions = { ...options };
                newOptions.cds = path.join(options.folder, filePath);
                newOptions.output = replaceExt(newOptions.cds, ".ts");

                await this.processFile(newOptions);
            }
        }
    }

    /**
     * Process the file in the options.cds property
     *
     * @param options Parsed CLI options.
     * @memberof Program
     */
    private async processFile(options: IOptions) {
        console.info(`Processing file ${options.cds}`);

        // Load compiled CDS.
        const jsonObj = await this.loadCdsAndConvertToJSON(
            options.cds,
            options.sort
        );

        // Write the compiled CDS JSON to disc for debugging.
        if (options.json) {
            fs.writeFileSync(options.output + ".json", JSON.stringify(jsonObj));
        }

        // Parse compile CDS.
        const parsed = new CDSParser().parse(jsonObj as ICsn);

        // Remove the output file if it already exists.
        if (fs.existsSync(options.output)) {
            fs.removeSync(options.output);
        }

        // Initialize the formatter and retrieve its settings.
        const formatter = await this.createFormatter(options);
        const settings = formatter.getSettings();

        // Create ts-morph project and source file to write to.
        const project = new morph.Project({ manipulationSettings: settings });
        const source = project.createSourceFile(options.output);

        // Generate the actual source code.
        this.generateCode(source, parsed, options.prefix);

        // Extract source code and format it.
        source.formatText();
        const text = source.getFullText();
        const formattedText = await formatter.format(text);

        // Write the actual source file.
        await this.writeSource(options.output, formattedText);
    }

    /**
     * Create watcher if watch option is configured
     *
     * @param options Parsed CLI options.
     * @memberof Program
     */
    private createWatcher(options: IOptions) {
        // If watch option not configured then don't create watcher
        if (!options.watch) return;

        // Create search filter
        let searchString = options.cds;

        if (options.folder) {
            searchString = `${options.folder}/*.cds`;
        }

        // Create watcher
        const watcher = chokidar.watch(searchString, {
            persistent: true,
            ignoreInitial: true,
        });

        // Watch for new files only if watcher configured on folder
        if (options.folder) {
            watcher.on("add", async (filePath: string) => {
                console.info(`File ${filePath} has been added!`);

                const newOptions = { ...options };
                newOptions.cds = filePath;
                newOptions.output = replaceExt(newOptions.cds, ".ts");

                await this.processFile(newOptions);
            });
        }

        // Watch for file changes
        watcher.on("change", async (filePath: string) => {
            console.info(`File ${filePath} has been changed!`);

            const newOptions = { ...options };
            newOptions.cds = filePath;
            newOptions.output = replaceExt(newOptions.cds, ".ts");

            await this.processFile(newOptions);
        });

        console.info(`Watching for changes with rule: ${searchString}`);
    }

    /**
     * Creates a formatter based on given options.
     *
     * @private
     * @param {IOptions} options Options to create a formatter for
     * @returns {Promise<Formatter>} Created formatter
     * @memberof Program
     */
    private async createFormatter(options: IOptions): Promise<Formatter> {
        return options.format
            ? await new PrettierFormatter(options.output).init()
            : await new NoopFormatter(options.output).init();
    }

    /**
     * Loads a given CDS file and parses the compiled JSON to a object.
     *
     * @private
     * @param {string} path Path to load the CDS file from.
     * @returns {Promise<any>}
     * @memberof Program
     */
    private async loadCdsAndConvertToJSON(
        path: string,
        sort: boolean
    ): Promise<unknown> {
        const csn = await cds.load(path);

        const result: ICsn = JSON.parse(cds.compile.to.json(csn));

        if (sort) {
            result.definitions = Object.fromEntries(
                Object.entries(result.definitions).sort((key, value) =>
                    String(key[0]).localeCompare(value[0])
                )
            );
        }

        return result;
    }

    /**
     * Extracts the types from a parsed service and generates the Typescript code.
     *
     * @private
     * @param {morph.SourceFile} source Source file to generate the typescript code in
     * @param {IParsed} parsed Parsed definitions, services and namespaces
     * @memberof Program
     */
    private generateCode(
        source: morph.SourceFile,
        parsed: IParsed,
        interfacePrefix = ""
    ): void {
        const namespaces: Namespace[] = [];

        if (parsed.namespaces) {
            const ns = parsed.namespaces.map(
                (n) => new Namespace(n.definitions, interfacePrefix, n.name)
            );

            namespaces.push(...ns);
        }

        if (parsed.services) {
            const ns = parsed.services.map(
                (s) => new Namespace(s.definitions, interfacePrefix, s.name)
            );

            namespaces.push(...ns);
        }

        if (parsed.definitions) {
            const ns = new Namespace(parsed.definitions, interfacePrefix);

            namespaces.push(ns);
        }

        for (const namespace of namespaces) {
            const types = _.flatten(namespaces.map((n) => n.getTypes()));
            namespace.generateCode(source, types);
        }
    }

    /**
     * Writes the types to disk.
     *
     * @private
     * @param {string} filepath File path to save the types at
     * @memberof Program
     */
    private async writeSource(filepath: string, source: string): Promise<void> {
        const dir = path.dirname(filepath);
        if (fs.existsSync(dir)) {
            await fs.writeFile(filepath, source);

            console.log(`Wrote types to '${filepath}'`);
        } else {
            console.error(
                `Unable to write types: '${dir}' is not a valid directory`
            );

            process.exit(-1);
        }
    }
}
