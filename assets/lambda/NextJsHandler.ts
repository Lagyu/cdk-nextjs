// based on:
// - https://github.com/iiroj/iiro.fi/commit/bd43222032d0dbb765e1111825f64dbb5db851d9
// - https://github.com/sladg/nextjs-lambda/blob/master/lib/standalone/server-handler.ts

import fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Tracer, captureLambdaHandler } from '@aws-lambda-powertools/tracer';
import middy from '@middy/core';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import type { NextConfig } from 'next';
import type { Options } from 'next/dist/server/next-server';
import * as nss from 'next/dist/server/next-server';
import slsHttp from 'serverless-http';

const tracer = new Tracer({ serviceName: 'nextjs' });

const getErrMessage = (e: any) => ({ message: 'Server failed to respond.', details: e });

// invoked by Lambda URL; the format is the same as API Gateway v2
// https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html#urls-payloads
type LambdaUrlFunctionHandler = APIGatewayProxyHandlerV2;

// somehow the default export gets buried inside itself...
const NextNodeServer: typeof nss.default = (nss.default as any)?.default ?? nss.default;

// load config
const nextDir = path.join(__dirname, '.next');
const requiredServerFilesPath = path.join(nextDir, 'required-server-files.json');
const json = fs.readFileSync(requiredServerFilesPath, 'utf-8');
const requiredServerFiles = JSON.parse(json) as { version: number; config: NextConfig };
const config: Options = {
  // Next.js compression should be disabled because of a bug
  // in the bundled `compression` package. See:
  // https://github.com/vercel/next.js/issues/11669
  conf: { ...requiredServerFiles.config, compress: false },
  customServer: false,
  dev: false,
  dir: __dirname,
  minimalMode: true,
};

// next request handler
const nextHandler = new NextNodeServer(config).getRequestHandler();

// wrap next request handler with serverless-http
// to translate from API Gateway v2 to next request/response
const server = slsHttp(
  async (req: IncomingMessage, res: ServerResponse) => {
    // annotate xray trace with request info

    await nextHandler(req, res).catch((e) => {
      console.error(`NextJS request failed due to:`);
      console.error(e);

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(getErrMessage(e), null, 3));
    });
  },
  {
    binary: ['*/*'],
    request: (request: any) => {
      // nextjs doesn't parse body if the property exists
      // https://github.com/dougmoscrop/serverless-http/issues/227
      delete request.body;
    },
    provider: 'aws',
  }
);

// wrap in middleware for xray tracing
// https://awslabs.github.io/aws-lambda-powertools-typescript/latest/core/tracer/#lambda-handler
export const handler: LambdaUrlFunctionHandler = middy(server).use(
  captureLambdaHandler(tracer, { captureResponse: false })
);
