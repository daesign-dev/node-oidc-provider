const assert = require('assert');
const { pick } = require('lodash');
const JWT = require('../../helpers/jwt');
const instance = require('../../helpers/weak_cache');

/*
 * Decrypts and validates the content of provided request parameter and replaces the parameters
 * provided via OAuth2.0 authorization request with these
 *
 * @throws: invalid_request_object
 */
module.exports = (provider, whitelist) => {
  const PARAM_LIST = Array.from(whitelist);
  const map = instance(provider);
  const conf = map.configuration;

  return async function decodeRequest(ctx, next) {
    const { params, client } = ctx.oidc;
    let wasSignedOrEncrypted = false;

    if (params.request === undefined) {
      await next();
      return;
    }

    if (conf('features.encryption') && params.request.split('.').length === 5) {
      try {
        const header = JWT.header(params.request);

        assert(conf('requestObjectEncryptionAlgValues').includes(header.alg),
          'unsupported encrypted request alg');
        assert(conf('requestObjectEncryptionEncValues').includes(header.enc),
          'unsupported encrypted request enc');

        const decrypted = await JWT.decrypt(params.request, map.keystore);
        wasSignedOrEncrypted = true;
        params.request = decrypted.payload.toString('utf8');
      } catch (err) {
        ctx.throw(400, 'invalid_request_object', {
          error_description: `could not decrypt request object (${err.message})`,
        });
      }
    }

    let decoded;

    try {
      decoded = JWT.decode(params.request);
    } catch (err) {
      ctx.throw(400, 'invalid_request_object', {
        error_description: `could not parse request object as valid JWT (${err.message})`,
      });
    }

    const { payload, header: { alg } } = decoded;

    if (payload.request !== undefined || payload.request_uri !== undefined) {
      ctx.throw(400, 'invalid_request_object', {
        error_description: 'request object must not contain request or request_uri properties',
      });
    }

    if (payload.response_type !== undefined && payload.response_type !== params.response_type) {
      ctx.throw(400, 'invalid_request_object', {
        error_description: 'request response_type must equal the one in request parameters',
      });
    }

    if (payload.client_id !== undefined && payload.client_id !== params.client_id) {
      ctx.throw(400, 'invalid_request_object', {
        error_description: 'request client_id must equal the one in request parameters',
      });
    }


    if (client.requestObjectSigningAlg && client.requestObjectSigningAlg !== alg) {
      ctx.throw(400, 'invalid_request_object', {
        error_description: 'the preregistered alg must be used in request or request_uri',
      });
    }

    ctx.assert(conf('requestObjectSigningAlgValues').includes(alg), 400, 'invalid_request_object', {
      error_description: 'unsupported signed request alg',
    });

    if (alg !== 'none') {
      try {
        const opts = {
          issuer: payload.iss ? client.clientId : undefined,
          audience: payload.aud ? provider.issuer : undefined,
        };
        await JWT.verify(params.request, client.keystore, opts);
        wasSignedOrEncrypted = true;
      } catch (err) {
        ctx.throw(400, 'invalid_request_object', {
          error_description: `could not validate request object (${err.message})`,
        });
      }
    }

    const request = pick(payload, PARAM_LIST);
    // TODO: request.claims should be an object, but we need it as JSON to have unified handling
    if (wasSignedOrEncrypted) ctx.oidc.signed = Object.keys(request);
    Object.assign(params, request);

    params.request = undefined;

    await next();
  };
};
