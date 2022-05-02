import { TWThingTransformerFactory, TWConfig, TWEntityKind } from 'bm-thing-transformer';
import * as fs from 'fs';
import * as ts from 'typescript';
import { TSUtilities } from '../Utilities/TSUtilities';
import { APIGenerator } from '../Utilities/APIDeclarationGenerator';

/**
 * Creates a typescript declarations file for the exported types, to be consumed in a frontend or node project.
 */
export function generateAPI() {

    const cwd = process.cwd();
    // Load the twconfig file which contains compilation options.
    const twConfig = require(`${cwd}/twconfig.json`) as TWConfig;

    process.stdout.write(`\x1b[1;31m✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖\x1b[0m\n`);
    process.stdout.write(`\x1b[1;31m✖✖✖✖✖✖✖\x1b[0m Building exported APIs is considered experimental and subject to change \x1b[1;31m✖✖✖✖✖✖✖\x1b[0m\n`);
    process.stdout.write(`\x1b[1;31m✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖✖\x1b[0m\n`);

    process.stdout.write(`\x1b[2m❯\x1b[0m Building exported API`);
    
    // Create a new store for each project
    twConfig.store = {};

    // Create the typescript project and emit using a transformer
    const program = TSUtilities.programWithPath(cwd);
    const tsFiles = program.getSourceFiles().filter(file => !file.fileName.endsWith('.d.ts'));
    for (const file of tsFiles) {
        ts.transform(file, [TWThingTransformerFactory(program, cwd, false, false, twConfig)], program.getCompilerOptions());
    }

    // Accumulate the declarations into a single file
    let declarations = "import { ServiceResult, DATETIME, JSON INFOTABLE, NOTHING, NUMBER, STRING, INTEGER, BOOLEAN, TWJSON, LOCATION, IMAGE, HYPERLINK, PASSWORD, TEXT, HTML, GUID, BLOB, LONG, THINGNAME } from './global';\n";
    let runtime = "const DataShapesDefinitions = { ";
    
    for (const key in twConfig.store) {
        if (key.startsWith('@')) continue;
        const entity = twConfig.store[key];
        if (entity.exported) {
            if (entity.entityKind == TWEntityKind.DataShape) {
                declarations += `
                    export interface ${entity.exportedName} {
                        ${entity.fields.map(f => APIGenerator.declarationOfProperty(f)).join('\n')}
                    }`,
                    runtime += `${entity.exportedName}: ${JSON.stringify(entity.fields)},\n`
            } else if (entity.entityKind == TWEntityKind.Thing) {
                declarations += `
                    export class ${entity.exportedName} {
                        ${entity.services.map(f => APIGenerator.declarationOfService(f)).join('\n')}
                    }
                    export interface Things {
                        "${entity.exportedName}": ${entity.exportedName};
                    }`;
            } else {
                throw new Error('Only Things and DataShapes can be exposed in API');
            }
        }
    }

    runtime += "}\n";
    runtime += `
    /**
     * Creates a new infotable JSON object with the specified rows and dataShape name.
     * Effectively wraps an array of rows into an infotable
     * Uses dataShape definitions generated by the backend.
     * @param rows Rows of the infotable to be included
     * @param dataShapeName Name of the datashape that should be used
     * @param minimal If a version of the field definitions with minimal information (name and baseType) should be used
     * @returns An object representing the infotable
     */
    export function createInfotableWithDs<T>(
      rows: T[],
      dataShapeName: keyof typeof DataShapesDefinitions,
      minimal = true,
    ): INFOTABLE<T> {
      if (!DataShapesDefinitions[dataShapeName]) {
        throw new Error(\`Cannot construct infotable with unknown dataShape '\${dataShapeName}.\`);
      }
      const simplifyField = (field: FieldDefinitionBase) => ({ name: field.name, baseType: field.baseType });
      const fields = Array.from(DataShapesDefinitions[dataShapeName]);
    
      return {
        dataShape: {
          fieldDefinitions: fields.reduce(
            (obj: { [key: string]: FieldDefinitionBase<T> }, field: FieldDefinitionBase) => (
              (obj[field.name] = minimal ? simplifyField(field) : field), obj
            ),
            {},
          ),
        },
        rows: rows,
      };
    }
    `;

    // Write the declarations to a .d.ts file
    TSUtilities.ensurePath(`${cwd}/api`, cwd);
    fs.writeFileSync(`${cwd}/api/Generated.d.ts`, declarations);
    fs.writeFileSync(`${cwd}/api/Runtime.ts`, runtime);

    process.stdout.write(`\r\x1b[1;32m✔\x1b[0m Built exported API   \n`);
}