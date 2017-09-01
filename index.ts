import { GraphQLClient } from 'graphql-request';
import {
  DocumentNode,
  SelectionSetNode,
  OperationTypeNode,
  TypeDefinitionNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,

  GraphQLSchema,
  GraphQLNamedType,
  GraphQLObjectType,
  IntrospectionQuery,

  parse,
  printSchema,
  buildClientSchema,
  introspectionQuery,
} from 'graphql';

import {
  keyBy,
  flatten,
  fromPairs,
  mapValues,
} from 'lodash';

import {
  validateDirectives,
  getSendDirective,
  getResolveWithDirective,
} from './directives';

import { RemoteSchemasMap } from './types';

import {
  SplittedAST,

  stubType,
  isBuiltinType,
  splitAST,
  makeASTDocument,
  schemaToASTTypes,
  readGraphQLFile,
  addPrefixToTypeNode,
  getExternalTypeNames,
  getTypesWithDependencies,
  buildSchemaFromSDL,
} from './utils';

// GLOBAL TODO:
//   - check that mutation is executed in sequence
//   - handle 'argumentsFragment' on root fields

async function getRemoteSchema(settings): Promise<GraphQLSchema> {
  const { url, headers } = settings;
  const client = new GraphQLClient(url, { headers });
  const introspection = await client.request(introspectionQuery) as IntrospectionQuery;
  return buildClientSchema(introspection);
}

async function getRemoteSchemas(): Promise<RemoteSchemasMap> {
  const promises = Object.entries(endpoints).map(
    async ([name, endpoint]) => {
      const {prefix, ...settings} = endpoint;
      return [name, {
        prefix,
        schema: await getRemoteSchema(settings),
      }]
    }
  );
  return Promise.all(promises).then(pairs => fromPairs(pairs));
}

type Endpoint = {
  prefix?: string
  url: string
  headers?: {[name: string]: string}
};

const endpoints: { [name: string]: Endpoint } = {
  graphcool: {
    url: 'http://localhost:9002/graphql'
  },
  yelp: {
    prefix: 'Yelp_',
    url: 'https://api.yelp.com/v3/graphql',
    headers: {
      'Authorization': 'Bearer ' + process.env.YELP_TOKEN
    }
    // TODO: headers white listing from request
  }
};

type OriginTypes = { type: GraphQLNamedType, originAPI: string }[];

function buildJoinSchema(
  joinDefs: SplittedAST,
  remoteSchemas: RemoteSchemasMap,
): GraphQLSchema {
  const extTypeRefs = getExternalTypeNames(joinDefs);
  const remoteTypes = getRemoteTypes(remoteSchemas, extTypeRefs);
  const schema = buildSchemaFromSDL({
    ...joinDefs,
    types: [
      ...joinDefs.types,
      ...remoteTypes.map(type => type.ast),
    ],
  });

  for (const { ast, originTypes } of remoteTypes) {
    schema.getType(ast.name.value)['originTypes'] = originTypes;
  }
  return schema;
}

function getRemoteTypes(
  remoteSchemas: RemoteSchemasMap,
  extTypeRefs: string[]
) {
  const remoteTypes = [] as {ast: TypeDefinitionNode, originTypes: OriginTypes }[];
  for (const [api, {schema, prefix = ''}] of Object.entries(remoteSchemas)) {
    const typesMap = keyBy(schemaToASTTypes(schema), 'name.value');

    const typesToExtract = extTypeRefs
      .filter(name => name.startsWith(prefix))
      .map(name => name.replace(prefix, ''))
      .filter(name => typesMap[name]);

    const extractedTypes = getTypesWithDependencies(typesMap, typesToExtract);
    for (const typeName of extractedTypes) {
      // TODO: merge types with same name and definition
      remoteTypes.push({
        ast: addPrefixToTypeNode(typesMap[typeName], prefix),
        originTypes: [{
          type: schema.getType(typeName),
          originAPI: api,
        }],
      });
    }
  }
  return remoteTypes;
}

type ResolveWithArgs = {
  query: ProxyOperation;
  argumentsFragment?: FragmentDefinitionNode;
};

function joinSchemas(
  joinAST: DocumentNode,
  remoteSchemas: RemoteSchemasMap,
): GraphQLSchema {
  const joinDefs = splitAST(joinAST);
  const schema = buildJoinSchema(joinDefs, remoteSchemas);
  console.log(printSchema(schema));

  const operations = keyBy(
    joinDefs.operations.map(op => new ProxyOperation(op)),
    op => op.name
  );
  const fragments = keyBy(
    joinDefs.fragments,
    f => f.name.value
  );

  for (const type of Object.values(schema.getTypeMap())) {
    if (isBuiltinType(type.name)) continue;

    stubType(type);

    if (type instanceof GraphQLObjectType) {
      for (const field of Object.values(type.getFields())) {
        const args = getResolveWithArgs(type, field);
        if (args) {
          field.resolve = resolveWith(args);
        }
      }
    }
  }

  return schema;

  function getResolveWithArgs(type, field): ResolveWithArgs | undefined {
    let args = getResolveWithDirective(field['astNode']);
    if (args) {
      return {
        query: operations[args.query],
        argumentsFragment: args.argumentsFragment ?
          fragments[args.argumentsFragment]: undefined,
      };
    }

    const operationType = getOperationType(type);
    if (operationType) {
      // Root type always have only one origin type
      const { originAPI } = (type['originTypes'] as OriginTypes)[0];
      return {
        query: operationForRootField(operationType, originAPI, field.name),
      };
    }
    return undefined;
  }

  function getOperationType(
    type: GraphQLNamedType
  ): OperationTypeNode | undefined {
    if (type === schema.getQueryType()) {
      return 'query';
    } else if (type === schema.getMutationType()) {
      return 'mutation';
    }
  }
}


function resolveWith(args: ResolveWithArgs) {
  return () => {
    console.log('test3');
  }
}

function operationForRootField(
  operationType: OperationTypeNode,
  sendTo: string,
  fieldName: string
): ProxyOperation {
  const ast = parse(
    `${operationType} @send(to: "${sendTo}") { ${fieldName} { ...CLIENT_SELECTION } }`,
    { noLocation: true }
  );
  const operation = ast.definitions[0] as OperationDefinitionNode;
  return new ProxyOperation(operation);
}

// TODO: call proxy know about fragments from orinal query
// TODO: don't forget to stip type prefixes from user selection parts and fragments before proxing
class ProxyOperation {
  name?: string;
  sendTo: string;
  operationType: OperationTypeNode;
  _resultPath: string[];
  _selectionSet: SelectionSetNode;

  constructor(operationDef: OperationDefinitionNode) {
    this.name = operationDef.name && operationDef.name.value;
    this.operationType = operationDef.operation;
    this.sendTo = getSendDirective(operationDef)!.to;
  }

  wrapSelection(args: object, clientSelection: SelectionSetNode): SelectionSetNode {
    return clientSelection;
  }

  makeResultObject(ExecuteResult): any {
  }
}

import * as express from 'express';
import * as graphqlHTTP from 'express-graphql';
async function main() {
  const joinAST = readGraphQLFile('./join.graphql');
  const remoteSchemas = await getRemoteSchemas();
  const joinSchema = joinSchemas(joinAST, remoteSchemas);

  const express = require('express');
  const graphqlHTTP = require('express-graphql');

  const app = express();

  app.use('/graphql', graphqlHTTP({
    schema: joinSchema,
    graphiql: true
  }));

  app.listen(4000);
  console.log('\n\nhttp://localhost:4000/graphql');
}

main().catch(e => {
  console.log(e);
});

function validation() {
  // TODO:
  // JOIN AST:
  //   - check for subscription in schema and `Subscription` type and error as not supported
  //   - validate that all directive known and locations are correct
  //   - no specified directives inside join AST
  //   - all references to remote types have no conficts
  //   - references to Query and Mutation roots point to exactly one type
  //   - all fields inside extends and type defs should have @resolveWith
  // fragments:
  //   - shoud have uniq names
  //   - shouldn't reference other fragments
  //   - should have atleast one leaf
  //   - all scalars should have exports directive
  //   - names in export directive should be uniq
  //   - should be used in @resolveWith
  //   - no field alliases
  // operations:
  //   - only query and mutation no subscription
  //   - should have name
  //   - shoud have uniq names
  //   - should have @send(to:)
  //   - valid against external schema
  //   - should have exactly one "leaf" which is "{...CLIENT_SELECTION}" or scalar
  //   - don't reference other fragments
  //   - should be used in @resolveWith
  //   - no field alliases
}
