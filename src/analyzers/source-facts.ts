import ts from "typescript";

export interface LocatedSignal {
  value: string;
  line: number;
  endLine: number;
  symbol: string | null;
}

export interface DataSourceSignal extends LocatedSignal {
  kind: "fetch" | "axios" | "ky" | "graphql" | "api-client";
}

export interface ModuleContractSignal extends LocatedSignal {
  kind:"nullable-return"|"registry";
}

export interface HttpErrorSignal extends LocatedSignal {
  status:number;
  message:string;
  condition:string|null;
}

export interface ServerFunctionSignal extends LocatedSignal {
  scope:"file"|"inline";
}

export interface CacheSemanticSignal extends LocatedSignal {
  operation:"use-cache"|"cacheLife"|"cacheTag"|"unstable_cache"|"revalidateTag"|"updateTag"|"revalidatePath"|"refresh";
  target:string|null;
  invalidates:boolean;
}

export interface SchemaContractSignal extends LocatedSignal {
  kind:"validation-schema"|"form-payload"|"json-payload";
  library:string;
  fields:string[];
}

export interface AuthorizationSignal extends LocatedSignal {
  mechanism:string;
  requirement:string|null;
  outcome:string|null;
}

export interface AnalyticsEventSignal extends LocatedSignal {
  event:string;
  transport:string;
  payloadKeys:string[];
}

/** `redirect()` / `notFound()` are control flow, not rendering: a page that redirects never renders. */
export interface ControlFlowSignal {
  kind:"redirect"|"permanent-redirect"|"not-found";
  target:string|null;
  /** False when the call runs on every request, which means the page never renders its own body. */
  conditional:boolean;
  line:number;
}

export interface SourceFacts {
  controlFlow: ControlFlowSignal[];
  /** Route segment config exports; authoritative over any signal found in a helper module. */
  segmentConfig: Record<string,string>;
  imports: LocatedSignal[];
  internalPackages: LocatedSignal[];
  envKeys: LocatedSignal[];
  dataSources: DataSourceSignal[];
  cacheBehavior: LocatedSignal[];
  clientBoundary: boolean;
  stateLibraries: LocatedSignal[];
  securitySignals: LocatedSignal[];
  performanceSignals: LocatedSignal[];
  businessRules: LocatedSignal[];
  moduleContracts: ModuleContractSignal[];
  httpErrors: HttpErrorSignal[];
  serverFunctions:ServerFunctionSignal[];
  cacheSemantics:CacheSemanticSignal[];
  schemaContracts:SchemaContractSignal[];
  authorization:AuthorizationSignal[];
  analyticsEvents:AnalyticsEventSignal[];
}

function nodeName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return node.name.getText();
  }
  // A local value (`const response = fetch(...)`) is evidence inside its owner,
  // not a traversal entry point. Only variables that themselves declare a
  // callable are symbols.
  if (ts.isVariableDeclaration(node)&&node.name&&node.initializer
    &&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer))) return node.name.getText();
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent=node.parent;
    if (ts.isVariableDeclaration(parent) && parent.name) return parent.name.getText();
  }
  return null;
}

function enclosingSymbol(node: ts.Node): string | null {
  let current: ts.Node | undefined=node;
  while (current) {
    const name=nodeName(current);
    if (name) return name;
    current=current.parent;
  }
  return null;
}

function located(source: ts.SourceFile, node: ts.Node, value: string): LocatedSignal {
  return {
    value,
    line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,
    endLine:source.getLineAndCharacterOfPosition(node.getEnd()).line+1,
    symbol:enclosingSymbol(node),
  };
}

function expressionValue(expression: ts.Expression | undefined): string {
  if (!expression) return "unknown";
  if (ts.isStringLiteralLike(expression)) return expression.text;
  return expression.getText().replace(/\s+/g," ").slice(0,240);
}

function objectProperty(expression:ts.Expression|undefined,name:string):ts.Expression|undefined {
  if (!expression||!ts.isObjectLiteralExpression(expression)) return undefined;
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key=property.name.getText().replace(/^["']|["']$/g,"");
    if (key===name) return property.initializer;
  }
  return undefined;
}

function propertyName(node:ts.PropertyName):string|null {
  if (ts.isIdentifier(node)||ts.isStringLiteralLike(node)||ts.isNumericLiteral(node)) return node.text;
  return null;
}

function objectKeys(expression:ts.Expression|undefined):string[] {
  if (!expression||!ts.isObjectLiteralExpression(expression)) return [];
  return expression.properties.flatMap((property)=>{
    if (ts.isSpreadAssignment(property)) return [];
    if (ts.isPropertyAssignment(property)||ts.isShorthandPropertyAssignment(property)||ts.isMethodDeclaration(property)) {
      const name=propertyName(property.name);
      return name ? [name] : [];
    }
    return [];
  });
}

function staticText(expression:ts.Expression|undefined):string|null {
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression)||ts.isNumericLiteral(expression)) return expression.text;
  if (expression.kind===ts.SyntaxKind.TrueKeyword) return "true";
  if (expression.kind===ts.SyntaxKind.FalseKeyword) return "false";
  return null;
}

function isAuthorizationReference(expression:ts.Expression,counterpart:ts.Expression):boolean {
  const semanticName=/^(?:userRole|permission|permissions|isAdmin|isAuthorized)$/i;
  if (ts.isParenthesizedExpression(expression)) return isAuthorizationReference(expression.expression,counterpart);
  if (ts.isIdentifier(expression)) return semanticName.test(expression.text)||(expression.text.toLowerCase()==="role"&&staticText(counterpart)!=null);
  if (ts.isPropertyAccessExpression(expression)) return semanticName.test(expression.name.text)||expression.name.text.toLowerCase()==="role";
  if (ts.isElementAccessExpression(expression)) {
    const name=staticText(expression.argumentExpression);
    return name!=null&&(semanticName.test(name)||name.toLowerCase()==="role");
  }
  if (ts.isPrefixUnaryExpression(expression)) return isAuthorizationReference(expression.operand,counterpart);
  return false;
}

function declarationName(node:ts.Node):string|null {
  let current:ts.Node|undefined=node;
  while (current) {
    if (ts.isVariableDeclaration(current)&&ts.isIdentifier(current.name)) return current.name.text;
    if ((ts.isFunctionDeclaration(current)||ts.isMethodDeclaration(current))&&current.name) return current.name.getText();
    current=current.parent;
  }
  return null;
}

function hasModifier(node:ts.Node,kind:ts.SyntaxKind):boolean {
  return ts.canHaveModifiers(node)&&Boolean(ts.getModifiers(node)?.some((modifier)=>modifier.kind===kind));
}

function functionBody(node:ts.Node):ts.Block|undefined {
  if (ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node)) {
    return node.body&&ts.isBlock(node.body) ? node.body : undefined;
  }
  return undefined;
}

function firstDirective(body:ts.Block|undefined):string|null {
  const statement=body?.statements[0];
  return statement&&ts.isExpressionStatement(statement)&&ts.isStringLiteral(statement.expression) ? statement.expression.text : null;
}

function controlCondition(node:ts.Node):string|null {
  let current:ts.Node|undefined=node;
  while (current.parent) {
    if (ts.isIfStatement(current.parent)) {
      const condition=current.parent.expression.getText().replace(/\s+/g," ").slice(0,240);
      return current.parent.elseStatement&&current.pos>=current.parent.elseStatement.pos ? `not (${condition})` : condition;
    }
    if (ts.isCatchClause(current.parent)) return "an exception is caught";
    current=current.parent;
  }
  return null;
}

function callIdentity(expression: ts.LeftHandSideExpression): {root:string;method:string|null} {
  if (ts.isIdentifier(expression)) return {root:expression.text,method:null};
  if (ts.isPropertyAccessExpression(expression)) {
    let root: ts.Expression=expression.expression;
    while (ts.isPropertyAccessExpression(root)) root=root.expression;
    return {root:ts.isIdentifier(root) ? root.text : root.getText(),method:expression.name.text};
  }
  return {root:expression.getText(),method:null};
}

function pushUnique<T extends LocatedSignal>(rows: T[], row: T, key: (item:T)=>string = (item)=>`${item.value}:${item.line}`): void {
  if (!rows.some((item)=>key(item)===key(row))) rows.push(row);
}

function nodeAtPosition(source:ts.SourceFile,position:number):ts.Node {
  let best:ts.Node=source;
  const visit=(node:ts.Node):void=>{
    if (node.getStart(source)<=position && node.getEnd()>=position) {
      best=node;
      ts.forEachChild(node,visit);
    }
  };
  visit(source);
  return best;
}

export function extractSourceFacts(sourceFile: string, content: string): SourceFacts {
  const source=ts.createSourceFile(sourceFile,content,ts.ScriptTarget.Latest,true,sourceFile.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts: SourceFacts={
    controlFlow:[],segmentConfig:{},
    imports:[],internalPackages:[],envKeys:[],dataSources:[],cacheBehavior:[],clientBoundary:false,
    stateLibraries:[],securitySignals:[],performanceSignals:[],businessRules:[],moduleContracts:[],httpErrors:[],
    serverFunctions:[],cacheSemantics:[],schemaContracts:[],authorization:[],analyticsEvents:[],
  };
  const statePattern=/(^|\/)(redux|zustand|jotai|mobx|recoil)(\/|$)|@reduxjs\/toolkit/;
  const moduleUseServer=source.statements.some((statement)=>
    ts.isExpressionStatement(statement)&&ts.isStringLiteral(statement.expression)&&statement.expression.text==="use server");
  const usesValibot=/from\s+["']valibot["']/.test(content);
  const usesYup=/from\s+["'](?:yup|@hookform\/resolvers\/yup)["']/.test(content);
  const nextCacheImports=new Map<string,CacheSemanticSignal["operation"]>();
  const nextCacheNamespaces=new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)||statement.moduleSpecifier.text!=="next/cache") continue;
    const bindings=statement.importClause?.namedBindings;
    if (bindings&&ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported=(element.propertyName ?? element.name).text as CacheSemanticSignal["operation"];
        if (["cacheLife","cacheTag","unstable_cache","revalidateTag","updateTag","revalidatePath","refresh"].includes(imported)) nextCacheImports.set(element.name.text,imported);
      }
    } else if (bindings&&ts.isNamespaceImport(bindings)) nextCacheNamespaces.add(bindings.name.text);
  }
  const explicitlyExported=new Set<string>();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)&&!statement.moduleSpecifier&&statement.exportClause&&ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) explicitlyExported.add((element.propertyName ?? element.name).text);
    }
  }

  if (moduleUseServer) {
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement)&&statement.name&&(hasModifier(statement,ts.SyntaxKind.ExportKeyword)||explicitlyExported.has(statement.name.text))&&hasModifier(statement,ts.SyntaxKind.AsyncKeyword)) {
        const base=located(source,statement,statement.name.text);
        pushUnique(facts.serverFunctions,{...base,symbol:statement.name.text,scope:"file"});
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)||!(hasModifier(statement,ts.SyntaxKind.ExportKeyword)||explicitlyExported.has(declaration.name.text))||!declaration.initializer
            ||!(ts.isArrowFunction(declaration.initializer)||ts.isFunctionExpression(declaration.initializer))||!hasModifier(declaration.initializer,ts.SyntaxKind.AsyncKeyword)) continue;
          const base=located(source,declaration,declaration.name.text);
          pushUnique(facts.serverFunctions,{...base,symbol:declaration.name.text,scope:"file"});
        }
      }
    }
  }

  const CONTROL_FLOW:Record<string,ControlFlowSignal["kind"]>={
    redirect:"redirect",permanentRedirect:"permanent-redirect",notFound:"not-found",
  };
  /** True when the call sits under a branch, so the page can still render its own body. */
  const underBranch=(node:ts.Node):boolean=>{
    let current:ts.Node|undefined=node.parent;
    while (current&&!ts.isFunctionDeclaration(current)&&!ts.isArrowFunction(current)&&!ts.isFunctionExpression(current)) {
      if (ts.isIfStatement(current)||ts.isConditionalExpression(current)||ts.isSwitchStatement(current)||ts.isCatchClause(current)) return true;
      if (ts.isBinaryExpression(current)&&
        (current.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken||current.operatorToken.kind===ts.SyntaxKind.BarBarToken||
         current.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken)) return true;
      current=current.parent;
    }
    return false;
  };

  const visit=(node:ts.Node):void=>{
    if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text==="use client") facts.clientBoundary=true;
    if (ts.isExpressionStatement(node)&&ts.isStringLiteral(node.expression)&&node.parent===source&&node.expression.text.startsWith("use cache")) {
      const directive=node.expression.text;
      const base=located(source,node,directive);
      pushUnique(facts.cacheSemantics,{...base,operation:"use-cache",target:directive.replace(/^use cache:?\s*/,"")||"default",invalidates:false});
      pushUnique(facts.cacheBehavior,located(source,node,directive));
    }

    const body=functionBody(node);
    if (body&&firstDirective(body)==="use server") {
      const symbol=declarationName(node) ?? enclosingSymbol(node) ?? "anonymous-server-function";
      const base=located(source,node,symbol);
      pushUnique(facts.serverFunctions,{...base,symbol,scope:"inline"});
    }
    if (body&&firstDirective(body)?.startsWith("use cache")) {
      const directive=firstDirective(body)!;
      const base=located(source,body.statements[0]!,directive);
      pushUnique(facts.cacheSemantics,{...base,operation:"use-cache",target:directive.replace(/^use cache:?\s*/,"")||"default",invalidates:false});
      pushUnique(facts.cacheBehavior,located(source,body.statements[0]!,directive));
    }

    if (ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&CONTROL_FLOW[node.expression.text]) {
      const first=node.arguments[0];
      facts.controlFlow.push({
        kind:CONTROL_FLOW[node.expression.text]!,
        target:first&&ts.isStringLiteralLike(first) ? first.text : null,
        conditional:underBranch(node),
        line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,
      });
      if (first&&ts.isStringLiteralLike(first)&&/(?:^|\/)(?:login|sign-in|signin)(?:\/|$|\?)/i.test(first.text)) {
        const base=located(source,node,first.text);
        pushUnique(facts.authorization,{...base,mechanism:"login-redirect",requirement:"authenticated user",outcome:`redirect ${first.text}`});
      }
    }

    if (ts.isVariableStatement(node)
      &&(node.modifiers ?? []).some((item)=>item.kind===ts.SyntaxKind.ExportKeyword)
      &&node.parent?.kind===ts.SyntaxKind.SourceFile) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)||!declaration.initializer) continue;
        const name=declaration.name.text;
        if (!["dynamic","revalidate","fetchCache","runtime","dynamicParams","preferredRegion"].includes(name)) continue;
        const initializer=declaration.initializer;
        const value=ts.isStringLiteralLike(initializer) ? initializer.text
          : ts.isNumericLiteral(initializer) ? initializer.text
          : initializer.kind===ts.SyntaxKind.TrueKeyword ? "true"
          : initializer.kind===ts.SyntaxKind.FalseKeyword ? "false" : null;
        if (value!=null) facts.segmentConfig[name]=value;
      }
    }

    if (sourceFile.startsWith("src/")&&ts.isVariableDeclaration(node)&&node.parent?.parent?.parent===source&&ts.isIdentifier(node.name)
      &&node.initializer&&ts.isObjectLiteralExpression(node.initializer)
      &&/(?:config|registry|adapter|provider|feature|handler)/i.test(node.name.text)) {
      const keys=node.initializer.properties.flatMap((property)=>{
        if (ts.isPropertyAssignment(property)||ts.isShorthandPropertyAssignment(property)||ts.isMethodDeclaration(property)) {
          return [property.name.getText().replace(/^["']|["']$/g,"")];
        }
        return [];
      }).slice(0,30);
      if (keys.length) {
        const base=located(source,node,`${node.name.text} defines registered entries: ${keys.join(", ")}`);
        pushUnique(facts.moduleContracts,{...base,kind:"registry"});
      }
    }

    if (ts.isReturnStatement(node)&&node.expression) {
      let condition:string|null=null;
      const expression=node.expression;
      if (expression.kind===ts.SyntaxKind.NullKeyword) condition=controlCondition(node) ?? "the function reaches its null return";
      else if (ts.isConditionalExpression(expression)) {
        if (expression.whenTrue.kind===ts.SyntaxKind.NullKeyword) condition=expression.condition.getText();
        else if (expression.whenFalse.kind===ts.SyntaxKind.NullKeyword) condition=`not (${expression.condition.getText()})`;
      } else if (ts.isBinaryExpression(expression)&&expression.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken
        &&expression.right.kind===ts.SyntaxKind.NullKeyword) condition=`${expression.left.getText()} is nullish`;
      const contractEligible=!sourceFile.endsWith(".tsx")||/(?:^|\/)lib\//.test(sourceFile);
      if (condition&&contractEligible) {
        const symbol=enclosingSymbol(node);
        const base=located(source,node,`${symbol ?? "function"} can return null when ${condition.replace(/\s+/g," ").slice(0,260)}`);
        pushUnique(facts.moduleContracts,{...base,kind:"nullable-return"});
      }
    }

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const value=node.moduleSpecifier.text;
      const signal=located(source,node,value);
      pushUnique(facts.imports,signal,(item)=>item.value);
      if (value.startsWith("@hangikredi/")) {
        const packageName=value.split("/").slice(0,2).join("/");
        pushUnique(facts.internalPackages,{...signal,value:packageName},(item)=>item.value);
      }
      if (statePattern.test(value)) pushUnique(facts.stateLibraries,signal,(item)=>item.value);
      // RCE-006 R3: `react` is imported by every client component, so it is a baseline
      // property, not an observation. Only the code-splitting import is a signal.
      if (value==="next/dynamic") pushUnique(facts.performanceSignals,located(source,node,`dynamic import ${value}`));
      if (/(jose|jsonwebtoken|dompurify|sanitize-html)/.test(value)) pushUnique(facts.securitySignals,located(source,node,`security package ${value}`));
    }

    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const left=node.expression;
      if (ts.isIdentifier(left.expression) && left.expression.text==="process" && left.name.text==="env") {
        pushUnique(facts.envKeys,located(source,node,node.name.text),(item)=>item.value);
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const left=node.expression;
      if (ts.isIdentifier(left.expression) && left.expression.text==="process" && left.name.text==="env" && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
        pushUnique(facts.envKeys,located(source,node,node.argumentExpression.text),(item)=>item.value);
      }
    }

    if (ts.isCallExpression(node)) {
      const identity=callIdentity(node.expression);
      let kind: DataSourceSignal["kind"] | null=null;
      if (identity.root==="fetch") kind="fetch";
      else if (identity.root==="axios") kind="axios";
      else if (identity.root==="ky") kind="ky";
      else if (/graphql|apollo/i.test(identity.root)) kind="graphql";
      else if (/(api|http|client)$/i.test(identity.root) && /^(get|post|put|patch|delete|request|query|mutate)$/i.test(identity.method ?? "")) kind="api-client";
      if (kind) {
        const base=located(source,node,expressionValue(node.arguments[0]));
        pushUnique(facts.dataSources,{...base,kind});
      }
      const callName=identity.method ?? identity.root;
      const operation=nextCacheImports.get(identity.root)
        ?? (identity.method&&nextCacheNamespaces.has(identity.root)&&["cacheLife","cacheTag","unstable_cache","revalidateTag","updateTag","revalidatePath","refresh"].includes(identity.method)
          ? identity.method as CacheSemanticSignal["operation"] : undefined);
      if (operation) {
        pushUnique(facts.cacheBehavior,located(source,node,`${operation}()`));
        const base=located(source,node,`${operation}(${expressionValue(node.arguments[0])})`);
        pushUnique(facts.cacheSemantics,{...base,operation,target:staticText(node.arguments[0]) ?? (node.arguments[0] ? expressionValue(node.arguments[0]) : null),invalidates:["revalidatePath","revalidateTag","updateTag","refresh"].includes(operation)});
      }

      const calleeText=node.expression.getText();
      const schemaLibrary=/^z\.(?:object|strictObject)$/.test(calleeText) ? "zod"
        : calleeText==="yup.object"||calleeText.endsWith(".shape")||(usesYup&&calleeText==="object") ? "yup"
        : usesValibot&&calleeText==="object" ? "valibot" : null;
      if (schemaLibrary) {
        const shape=calleeText.endsWith(".shape") ? node.arguments[0] : node.arguments[0];
        const fields=objectKeys(shape);
        if (fields.length) {
          const symbol=declarationName(node) ?? enclosingSymbol(node);
          const base=located(source,node,`${symbol ?? "schema"}: ${fields.join(", ")}`);
          pushUnique(facts.schemaContracts,{...base,symbol,kind:"validation-schema",library:schemaLibrary,fields},(item)=>`${item.kind}:${item.symbol}:${item.fields.join(",")}`);
        }
      }
      if ((identity.method==="get"||identity.method==="getAll")&&/formdata/i.test(identity.root)) {
        const field=staticText(node.arguments[0]);
        if (field) {
          const base=located(source,node,field);
          pushUnique(facts.schemaContracts,{...base,kind:"form-payload",library:"FormData",fields:[field]});
        }
      }
      if (identity.root==="JSON"&&identity.method==="stringify") {
        const fields=objectKeys(node.arguments[0]);
        if (fields.length) {
          const base=located(source,node,fields.join(", "));
          pushUnique(facts.schemaContracts,{...base,kind:"json-payload",library:"JSON",fields});
        }
      }

      const authorizationCalls=/^(?:auth|authenticate|authorize|getServerSession|getSession|requireUser|requireAuth|hasPermission|checkPermission|forbidden|unauthorized)$/i;
      if (authorizationCalls.test(callName)) {
        const requirement=staticText(node.arguments[0]) ?? (node.arguments[0] ? expressionValue(node.arguments[0]) : null);
        const outcome=/^(?:forbidden|unauthorized)$/i.test(callName) ? callName.toLowerCase() : null;
        const base=located(source,node,`${callName}${requirement ? `: ${requirement}` : ""}`);
        pushUnique(facts.authorization,{...base,mechanism:callName,requirement,outcome});
      }

      let event:string|null=null;
      let transport:string|null=null;
      let payload:ts.Expression|undefined;
      if (identity.root==="gtag"&&staticText(node.arguments[0])==="event") {
        event=staticText(node.arguments[1]); transport="gtag"; payload=node.arguments[2];
      } else if ((identity.method==="track"||/^(?:trackEvent|sendEvent|logEvent)$/.test(callName))) {
        event=staticText(node.arguments[0]); transport=identity.method ? `${identity.root}.${identity.method}` : identity.root; payload=node.arguments[1];
      } else if ((identity.root==="dataLayer"||calleeText.endsWith(".dataLayer.push"))&&identity.method==="push") {
        event=staticText(objectProperty(node.arguments[0],"event")); transport="dataLayer.push"; payload=node.arguments[0];
      }
      if (event&&transport) {
        const keys=objectKeys(payload).filter((key)=>key!=="event");
        const base=located(source,node,event);
        pushUnique(facts.analyticsEvents,{...base,event,transport,payloadKeys:keys},(item)=>`${item.event}:${item.line}`);
      }
      if (["memo","useMemo","useCallback","dynamic"].includes(callName)) {
        pushUnique(facts.performanceSignals,located(source,node,`${callName}()`));
      }
      if ((identity.root==="Response"||identity.root==="NextResponse")&&identity.method==="json") {
        const statusExpression=objectProperty(node.arguments[1],"status");
        const status=statusExpression&&ts.isNumericLiteral(statusExpression) ? Number(statusExpression.text) : null;
        if (status!=null&&status>=400) {
          const messageExpression=objectProperty(node.arguments[0],"message") ?? objectProperty(node.arguments[0],"error");
          const message=messageExpression&&ts.isStringLiteralLike(messageExpression)
            ? messageExpression.text : expressionValue(node.arguments[0]);
          const base=located(source,node,`${identity.root}.json returns HTTP ${status}: ${message}`);
          pushUnique(facts.httpErrors,{...base,status,message,condition:controlCondition(node)});
        }
      }
    }

    if (ts.isBinaryExpression(node)&&(isAuthorizationReference(node.left,node.right)||isAuthorizationReference(node.right,node.left))) {
      const requirement=[node.left,node.right].map(staticText).find((value)=>value!=null) ?? node.getText().replace(/\s+/g," ").slice(0,180);
      const base=located(source,node,requirement);
      pushUnique(facts.authorization,{...base,mechanism:"role-or-permission-check",requirement,outcome:null});
    }
    ts.forEachChild(node,visit);
  };
  visit(source);

  for (const match of content.matchAll(/cache\s*:\s*["'](no-store|force-cache)["']/g)) {
    const pos=match.index ?? 0;
    pushUnique(facts.cacheBehavior,located(source,nodeAtPosition(source,pos),`fetch cache=${match[1]}`));
  }
  for (const match of content.matchAll(/\brevalidate\s*[:=]\s*(\d+|false)/g)) {
    const pos=match.index ?? 0;
    pushUnique(facts.cacheBehavior,located(source,nodeAtPosition(source,pos),`revalidate=${match[1]}`));
  }
  for (const match of content.matchAll(/(?:Content-Security-Policy|X-Frame-Options|strict-transport-security|nonce\b|sanitize\w*\s*\()/gi)) {
    pushUnique(facts.securitySignals,located(source,nodeAtPosition(source,match.index ?? 0),match[0]));
  }
  for (const match of content.matchAll(/BUSINESS_RULE\s*:\s*([^\n]+)/g)) {
    pushUnique(facts.businessRules,located(source,nodeAtPosition(source,match.index ?? 0),(match[1] ?? "").trim()));
  }
  return facts;
}

export function enrichEvidence(sourceFile:string, content:string, line:number | null | undefined): {symbol:string|null;endLine:number|null} {
  if (!line) return {symbol:null,endLine:null};
  const source=ts.createSourceFile(sourceFile,content,ts.ScriptTarget.Latest,true,sourceFile.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const offset=source.getPositionOfLineAndCharacter(Math.max(0,line-1),0);
  let best:ts.Node=source;
  const visit=(node:ts.Node):void=>{
    if (node.getStart(source)<=offset && node.getEnd()>=offset) {
      best=node;
      ts.forEachChild(node,visit);
    }
  };
  visit(source);
  return {symbol:enclosingSymbol(best),endLine:source.getLineAndCharacterOfPosition(best.getEnd()).line+1};
}
