declare var expect;

import {
  Source,
  DocumentNode,
  GraphQLError,
  GraphQLSchema,
  GraphQLFieldResolver,
  GraphQLResolveInfo,
  ExecutionArgs,
  ExecutionResult,
  isLeafType,
  getNamedType,

  graphql,
  parse,
  validate,
  execute,
  print,
  buildSchema,
  printSchema,
  formatError,
  specifiedRules,
} from 'graphql';
import * as _ from 'lodash';

import { GraphQLJoinSchema } from '../GraphQLJoinSchema';
import { ProxyContext } from '../ProxyContext';
import { stubSchema } from '../utils';

expect.addSnapshotSerializer({
  print(val) {
    return typeof val === 'string' ?
      val.trim() :
      JSON.stringify(val, null, 2);
  },
  test(val) {
    return true;
  },
});

function fakeFieldResolver(schemaName: string): GraphQLFieldResolver<any,any> {
  return (
    rootValue, args: object, _3,
    {fieldName, parentType, returnType}: GraphQLResolveInfo
  ) => {
    if ((typeof rootValue === 'object') && rootValue[fieldName]) {
      return rootValue[fieldName];
    }

    let result = `${schemaName}::${parentType.name}::${fieldName}`;
    if (Object.keys(args).length !== 0) {
      result += `;args=${JSON.stringify(args)}`
    }
    return result;
  }
}

function makeProxy(schemaName: string, schema: GraphQLSchema, rootValue?: any) {
  return (queryAST: DocumentNode, variableValues?: object) => {
    const query = print(queryAST);
    expect(query).toMatchSnapshot();
    // FIXME: Should use executeQuery but blocked by
    // https://github.com/facebook/jest/issues/3917
    return graphql({
      schema,
      source: new Source(query, 'Send to ' + schemaName),
      rootValue,
      variableValues,
      fieldResolver: fakeFieldResolver(schemaName),
    });
  };
}

type TestSchema = string | { idl: string, prefix?: string };
type TestSchemasMap = { [name: string]: TestSchema };
export function testJoin(testSchemas: TestSchemasMap, joinIDL: string) {
  const remoteSchemas = _.mapValues(testSchemas, (schemaSource, name) => {
    if (typeof schemaSource === 'string') {
      schemaSource = { idl: schemaSource };
    }
    const { prefix, idl } = schemaSource;
    const schema = buildSchema(new Source(idl, name));
    stubSchema(schema);
    return { schema , prefix};
  });

  const joinSchema = new GraphQLJoinSchema(
    new Source(joinIDL, 'Join IDL'),
    remoteSchemas
  );
  const schema = joinSchema.schema;

  expect(schema).toBeInstanceOf(GraphQLSchema);
  expect(printSchema(schema)).toMatchSnapshot();
  return async (
    query: string | {
      query: string,
      variableValues?: object
      rootValues?: { [schemaName: string]: any }
      results?: { [schemaName: string]: ExecutionResult }
    },
  ) => {
    const queryObj = typeof query === 'string' ? { query: query } : query;
    const { results, rootValues } = queryObj;

    const proxyFns = _.mapValues(remoteSchemas, ({schema}, name) => {
      if (results && results[name]) {
        return (queryAST) => {
          const query = print(queryAST);
          expect(query).toMatchSnapshot();
          return Promise.resolve(results[name])
        };
      }
      const rootValue = rootValues && rootValues[name];
      return makeProxy(name, schema, rootValue)
    });

    const result = await executeQuery({
      schema,
      document: parse(new Source(queryObj.query, 'ClientQuery')),
      variableValues: queryObj.variableValues,
      contextValue: new ProxyContext(joinSchema, proxyFns),
    });

    expect([
      queryObj.query,
      resultToJSON(result),
    ]).toMatchSnapshot();
  };
}

function executeQuery(args: ExecutionArgs) {
  const validationErrors = validate(args.schema, args.document, specifiedRules);
  expect(validationErrors.join('\n')).toBe('');
  return execute(args);
}

function resultToJSON(result) {
  return {
    ...result,
    errors: (result.errors || []).map(formatError),
  };
}

