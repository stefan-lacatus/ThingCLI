import { TWThingTransformerFactory, TWConfig, TWThingTransformer } from 'bm-thing-transformer';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { Builder, parseStringPromise } from 'xml2js';
import { TSUtilities } from '../Utilities/TSUtilities';
import ts from 'typescript';

const [path, bin, command, ...args] = process.argv;

/**
 * Builds the thingworx entity xml files from the typescript project.
 * @returns             A promise that resolves with an array of deployment
 *                      endpoints when the operation completes.
 */
export async function build(): Promise<string[]> {
    const cwd = process.cwd();

    // The array of deployment endpoints discovered while building
    const deploymentEndpoints: string[] = [];

    // Load the twconfig file which contains complication options.
    const twConfig = require(`${process.cwd()}/twconfig.json`) as TWConfig;
    const packageJSON = require(`${process.cwd()}/package.json`);

    // In multi project mode, a build mode should be specified, defaulting to separate if one is not provided
    const isMerged = args.includes('--merged');
    const isSeparate = args.includes('--separate') || !isMerged;

    if (twConfig.projectName == '@auto') {
        // If both modes are specified throw an error
        if (isMerged && isSeparate) {
            throw new Error(`🛑 \x1b[1;31mThe --merged and --separate arguments cannot be used together.\x1b[0m`);
        }
    }

    // If the debug flag is specified, apply it to the config
    const isDebugBuild = args.includes('--debug');
    twConfig.debug = isDebugBuild;

    // Clear the build output folder to remove any entities which may have been removed from the project
    if (fs.existsSync(`${cwd}/build`)) {
        fs.rmSync(`${cwd}/build`, {force: true, recursive: true});
    }

    if (twConfig.projectName == '@auto') {
        // If running in multi-project mode, run against each project separately
        const baseOutPath = `${cwd}/build`;

        // Before starting a build, ensure that the base out path exists
        if (!fs.existsSync(baseOutPath)) fs.mkdirSync(baseOutPath)

        for (const p of TSUtilities.projects()) {
            // For merged builds, everything ends up in the same extension while for
            // separate builds, each project is its own extension
            const outPath = isMerged ? baseOutPath : `${baseOutPath}/${p.name}`;
            await buildProject(p.name, p.path, outPath);
        }
    }
    else {
        // If running in single project mode, run against the whole repository
        const outPath = `${cwd}/build`;
        buildProject(twConfig.projectName, cwd, outPath);
    }

    /**
     * Builds the project at the given path.
     * @param projectName       The name of the project.
     * @param path              The project's path.
     * @param outPath           The project's target path.
     */
     async function buildProject(projectName: string, path: string, outPath: string): Promise<void> {
        // Ensure the outpath exists
        if (!fs.existsSync(outPath)) {
            fs.mkdirSync(outPath);
        }

        // Create a new store for each project
        twConfig.store = {};

        process.stdout.write(`\x1b[2m❯\x1b[0m Building ${projectName || 'project'}`);

        let tsConfig: any;
        if (fs.existsSync(`${path}/tsconfig.json`)) {
            tsConfig = require(`${path}/tsconfig.json`);
        }
    
        // Create the typescript project and emit using both transformers
        const program = TSUtilities.programWithPath(path, true);
        const emitResult = program.emit(undefined, () => {}, undefined, undefined, {
            before: [
                TWThingTransformerFactory(program, path, false, false, twConfig)
            ],
            after: [
                TWThingTransformerFactory(program, path, true, false, twConfig)
            ]
        });

        // Get and store all diagnostic messages generated by typescript to display them when the task
        // finishes
        const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
        const defaultFormatHost: ts.FormatDiagnosticsHost = {
            getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
            getCanonicalFileName: fileName => fileName,
            getNewLine: () => ts.sys.newLine
        };

        const formattedDiagnostics = ts.formatDiagnosticsWithColorAndContext(allDiagnostics, defaultFormatHost);

        // If an error causes a compilation failure, display the diagnostic messages and fail
        if (emitResult.emitSkipped) {
            process.stdout.write(`\r\x1b[1;31m✖\x1b[0m Failed building ${projectName || 'project'}\n`);

            console.log(formattedDiagnostics);

            throw new Error('Compilation failed.');
        }

        // Store an array of all transformers created, to be used to extract
        // debug information for the whole project
        const transformers: TWThingTransformer[] = [];

        // Write out the entity XML files
        for (const key in twConfig.store) {
            if (key == '@globalBlocks') continue;

            // Write the entity XML
            const transformer = twConfig.store[key];
            transformer.write(outPath);

            // Store any declared deployment endpoints
            if (transformer.deploymentEndpoints.length) {
                deploymentEndpoints.push(...transformer.deploymentEndpoints);
            }

            transformers.push(transformer);
        }

        // If project entity generation is enabled, create and write the project entity
        if (twConfig.generateProjectEntity) {
            const projectEntity = projectEntityNamed(projectName, twConfig, tsConfig);

            // Write the debug entity in the appropriate subfolder
            TSUtilities.ensurePath(`${outPath}/Entities/Projects`, outPath);
            fs.writeFileSync(`${outPath}/Entities/Projects/${projectName}.xml`, projectEntity);
        }

        // If this is a debug build, create a notifier thing that informs the debugger runtime that new source files are available
        if (isDebugBuild) {
            // Generate a random name for the debug entity and get its contents from the transformer
            const debugEntityName = randomUUID();
            const debugEntity = TWThingTransformer.projectDebugThingXML(debugEntityName, transformers, projectName);
            
            // Write the debug entity in the appropriate subfolder
            TSUtilities.ensurePath(`${outPath}/Entities/Things`, outPath);
            fs.writeFileSync(`${outPath}/Entities/Things/${debugEntityName}.xml`, debugEntity);
        }


        // Copy and update the metadata file
        const metadataFile = fs.readFileSync(`${process.cwd()}/metadata.xml`, 'utf8');
        const metadataXML = await parseStringPromise(metadataFile);

        // In multi project mode, for separate builds, append the project name to the package name
        let packageName = packageJSON.name;
        if (isSeparate && twConfig.projectName == '@auto') {
            packageName += `-${projectName}`;
        }

        const extensionPackage = metadataXML.Entities.ExtensionPackages[0].ExtensionPackage[0];
        extensionPackage.$.name = packageName;
        if (packageJSON.author) {
            extensionPackage.$.vendor = packageJSON.author;
        }
        extensionPackage.$.minimumThingWorxVersion = twConfig.minimumThingWorxVersion || packageJSON.minimumThingWorxVersion || '9.0.0';
        // For the package version, omit any beta or alpha suffix
        extensionPackage.$.packageVersion = packageJSON.version.split('-')[0];
        extensionPackage.$.description = packageJSON.description;
        extensionPackage.$.buildNumber = JSON.stringify({gitHubURL: packageJSON.autoUpdate?.gitHubURL || ''});

        const builder = new Builder();
        const outXML = builder.buildObject(metadataXML);

        fs.writeFileSync(`${outPath}/metadata.xml`, outXML);

        process.stdout.write(`\r\x1b[1;32m✔\x1b[0m Built ${projectName || 'project'}${formattedDiagnostics.length ? ' (with warnings):' : '     '}\n`);

        // Write out the diagnostic messages at the end of the task
        if (formattedDiagnostics) {
            console.log(formattedDiagnostics);
        }
    }

    return deploymentEndpoints;
}

/**
 * Creates and returns an XML string containing a project entity with the given name.
 * @param name          The project's name.
 * @param twConfig      The twconfig.json file containing the project's dependencies.
 * @param tsConfig      If specified, the sub-project's tsconfig file.
 * @returns             A string.
 */
function projectEntityNamed(name: string, twConfig: TWConfig, tsConfig?: any) {
    const builder = new Builder();
    const dependencies = {extensions: '', projects: ''};

    if (twConfig.includeProjectDependencies) {
        dependencies.extensions = (twConfig.extensionDependencies || []).join(',');
        dependencies.projects = (twConfig.projectDependencies || []).join(',');

        // If this is a sub-project, include any other sub-projects referenced in "include"
        if (tsConfig) {
            const includePaths = tsConfig.include as string[];

            // Include paths in the form of "../<ProjectName>"
            const projectDependencies = includePaths.map(p => p.split('/')).filter(components => {
                if (components.length != 2) return false;
                if (components[0] != '..') return false;
                if (components[1].includes('*') || components[1].includes('.')) return false;

                return true;
            }).map(c => c[1]);
            
            if (projectDependencies.length) {
                if (dependencies.projects.length) {
                    dependencies.projects += ',' + projectDependencies.join(',');
                }
                else {
                    dependencies.projects = projectDependencies.join(',');
                }
            }
        }
    }

    const projectEntity = {
        Entities: {
            Projects: [
                {
                    Project: [
                        {
                            $: {
                                artifactId: "",
                                "aspect.projectType": "Component",
                                dependsOn: JSON.stringify(dependencies),
                                description: "",
                                documentationContent: "",
                                groupId: "",
                                homeMashup: "",
                                minPlatformVersion: "",
                                name: name,
                                packageVersion: "1.0.0",
                                projectName: name,
                                publishResult: "",
                                state: "DRAFT",
                                tags: "",
                            },
                        },
                    ],
                },
            ],
        },
    };

    return builder.buildObject(projectEntity);
}