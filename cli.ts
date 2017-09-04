import * as express from 'express';
import * as graphqlHTTP from 'express-graphql';

import {
  EndpointMap,
  ProxyContext,
  joinSchemas,
  getRemoteSchemas,
} from './index';

import { readGraphQLFile } from './utils';

const endpoints: EndpointMap = {
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

async function main() {
  const joinAST = readGraphQLFile('./join.graphql');
  const remoteSchemas = await getRemoteSchemas(endpoints);
  const joinSchema = joinSchemas(joinAST, remoteSchemas);

  const app = express();

  app.use('/graphql', graphqlHTTP({
    schema: joinSchema,
    context: new ProxyContext(remoteSchemas),
    graphiql: true,
    formatError: error => ({
      message: error.message,
      locations: error.locations,
      stack: error.stack,
      path: error.path
    }),
  }));

  app.listen(4000);
  console.log('\n\nhttp://localhost:4000/graphql');
}

main().catch(e => {
  console.log(e);
});
