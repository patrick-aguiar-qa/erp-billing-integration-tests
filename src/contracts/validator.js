'use strict';

const Ajv = require('ajv');
const requestSchema = require('./request.schema.json');
const callbackSchema = require('./callback.schema.json');

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const requestValidator = ajv.compile(requestSchema);
const callbackValidator = ajv.compile(callbackSchema);

const format = (errors = []) =>
  errors.map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ''}`);

function validateRequest(body) {
  const valid = requestValidator(body);
  return { valid, errors: valid ? [] : format(requestValidator.errors) };
}

function validateCallback(body) {
  const valid = callbackValidator(body);
  return { valid, errors: valid ? [] : format(callbackValidator.errors) };
}

module.exports = { validateRequest, validateCallback };
