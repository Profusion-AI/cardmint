#!/usr/bin/env npx jscodeshift

/**
 * JSCodeshift Codemod: Ports Injection
 * Transforms direct concrete imports to use dependency injection via ports
 */
import { Transform, FileInfo, API, Options } from 'jscodeshift';

const transform: Transform = (fileInfo: FileInfo, api: API, options: Options) => {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  
  let hasChanges = false;
  
  // Skip wiring.ts and files that already use ports
  if (fileInfo.path.includes('wiring.ts') || fileInfo.source.includes("from '../app/wiring'")) {
    return fileInfo.source;
  }
  
  // Target patterns to replace with ports
  const targetImports = [
    // Image processing patterns
    { pattern: /ImageProcessor|ImageProcessorService/, port: 'image' },
    { pattern: /OpenCvImageProcessor/, port: 'image' },
    
    // Inference patterns  
    { pattern: /InferenceService|LmStudioInference|MLService/, port: 'infer' },
    
    // Validation patterns
    { pattern: /ValidationService|ImageValidation/, port: 'validate' },
  ];
  
  // 1. Remove concrete imports and add ports import
  root.find(j.ImportDeclaration).forEach((path) => {
    const source = path.value.source.value as string;
    const specifiers = path.value.specifiers || [];
    
    // Check if this import should be replaced with ports
    for (const { pattern, port } of targetImports) {
      const hasTargetImport = specifiers.some(spec => 
        spec.type === 'ImportDefaultSpecifier' && pattern.test(spec.local?.name || '') ||
        spec.type === 'ImportSpecifier' && pattern.test(spec.imported.name || '')
      );
      
      if (hasTargetImport && !source.includes('/app/wiring')) {
        // Remove the concrete import
        j(path).remove();
        hasChanges = true;
        
        // Add ports import if not already present
        const existingPortsImport = root.find(j.ImportDeclaration, {
          source: { value: '../app/wiring' }
        });
        
        if (existingPortsImport.length === 0) {
          const portsImport = j.importDeclaration(
            [j.importSpecifier(j.identifier('ports'))],
            j.literal('../app/wiring')
          );
          
          // Insert at the top after other imports
          const imports = root.find(j.ImportDeclaration);
          if (imports.length > 0) {
            imports.at(-1).insertAfter(portsImport);
          } else {
            root.get().node.body.unshift(portsImport);
          }
        }
        break;
      }
    }
  });
  
  // 2. Replace direct instantiations with ports usage
  targetImports.forEach(({ pattern, port }) => {
    // Replace: new ConcreteClass() with ports.port
    root.find(j.NewExpression).forEach((path) => {
      if (path.value.callee.type === 'Identifier' && pattern.test(path.value.callee.name)) {
        j(path).replaceWith(
          j.memberExpression(j.identifier('ports'), j.identifier(port))
        );
        hasChanges = true;
      }
    });
    
    // Replace: ConcreteClass.method() with ports.port.method()
    root.find(j.CallExpression).forEach((path) => {
      if (path.value.callee.type === 'MemberExpression' &&
          path.value.callee.object.type === 'Identifier' &&
          pattern.test(path.value.callee.object.name)) {
        
        const methodName = path.value.callee.property;
        const args = path.value.arguments;
        
        j(path).replaceWith(
          j.callExpression(
            j.memberExpression(
              j.memberExpression(j.identifier('ports'), j.identifier(port)),
              methodName
            ),
            args
          )
        );
        hasChanges = true;
      }
    });
    
    // Replace variable declarations: const service = new ConcreteClass()
    root.find(j.VariableDeclaration).forEach((path) => {
      path.value.declarations.forEach((decl) => {
        if (decl.init?.type === 'NewExpression' && 
            decl.init.callee.type === 'Identifier' &&
            pattern.test(decl.init.callee.name)) {
          
          decl.init = j.memberExpression(j.identifier('ports'), j.identifier(port));
          hasChanges = true;
        }
      });
    });
  });
  
  // 3. Add appropriate type imports if needed
  if (hasChanges) {
    const needsTypeImports = root.find(j.Identifier, { name: 'ports' });
    if (needsTypeImports.length > 0) {
      // Check if types are already imported
      const existingTypeImport = root.find(j.ImportDeclaration)
        .filter((path) => {
          const source = path.value.source.value as string;
          return source.includes('@core/') || source.includes('../core/');
        });
      
      if (existingTypeImport.length === 0) {
        // Add a comment suggesting manual type import review
        root.get().node.comments = root.get().node.comments || [];
        root.get().node.comments.push(
          j.commentBlock(' TODO: Review and add specific port type imports from @core/* ')
        );
      }
    }
  }
  
  return hasChanges ? root.toSource({ quote: 'single' }) : fileInfo.source;
};

transform.parser = 'tsx';

export default transform;