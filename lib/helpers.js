'use strict'

const inflection = require('inflection')
const deepEqual = require('deep-equal')

const settings = require('./settings')
const typeInflections = settings.typeInflections
const reservedKeys = settings.reservedKeys
const inBrackets = settings.inBrackets
const isField = settings.isField
const isFilter = settings.isFilter
const mediaType = settings.mediaType
const pageOffset = settings.pageOffset
const pageLimit = settings.pageLimit


module.exports = {
  initializeContext, mapRecord, mapId, matchId, castId,
  underscore, parseBuffer, checkLowerCase
}


function initializeContext (contextRequest, request, response) {
  const uriTemplate = this.uriTemplate
  const methodMap = this.methodMap
  const recordTypes = this.recordTypes
  const adapter = this.adapter
  const keys = this.keys
  const methods = this.methods

  const options = this.options
  const prefix = options.prefix
  const inflectType = options.inflectType
  const inflectKeys = options.inflectKeys
  const allowLevel = options.allowLevel

  const errors = this.errors
  const NotAcceptableError = errors.NotAcceptableError
  const NotFoundError = errors.NotFoundError

  // According to the spec, if the media type is provided in the Accept
  // header, it should be included at least once without any media type
  // parameters.
  if (request.headers['accept'] &&
    ~request.headers['accept'].indexOf(mediaType)) {
    const escapedMediaType = mediaType.replace(/[\+\.]/g, '\\$&')
    const mediaTypeRegex = new RegExp(`${escapedMediaType}(?!;)`, 'g')
    if (!request.headers['accept'].match(mediaTypeRegex))
      throw new NotAcceptableError('The "Accept" header should contain ' +
        'at least one instance of the JSON media type without any ' +
        'media type parameters.')
  }

  request.meta = {}

  const meta = contextRequest.meta

  const method = contextRequest.method = request.meta.method =
    methodMap[request.method]

  // URL rewriting for prefix parameter.
  if (prefix && request.url.indexOf(prefix) === 0)
    request.url = request.url.slice(prefix.length)

  // Decode URI Component only for the query string.
  const uriObject = contextRequest.uriObject = request.meta.uriObject =
    uriTemplate.fromUri(request.url)

  if (!Object.keys(uriObject).length && request.url.length > 1)
    throw new NotFoundError('Invalid URI.')

  const type = contextRequest.type = request.meta.type =
    uriObject.type ? inflectType ? checkLowerCase(inflection.transform(
      underscore(uriObject.type), typeInflections[0]), recordTypes) :
      uriObject.type : null

  // Show allow options.
  if (request.method === 'OPTIONS' && (!type || type in recordTypes)) {
    delete uriObject.query

    // Avoid making an internal request by throwing the response.
    const output = new Error()

    output.isMethodInvalid = true
    output.meta = {
      headers: {
        'Allow': allowLevel[Object.keys(uriObject)
          .filter(key => uriObject[key]).length].join(', ')
      }
    }

    response.statusCode = 204

    throw output
  }

  const ids = contextRequest.ids = request.meta.ids =
    uriObject.ids ? (Array.isArray(uriObject.ids) ?
      uriObject.ids : [ uriObject.ids ]).map(castId) : null

  const fields = recordTypes[type]

  attachQueries.call(this, contextRequest)
  request.meta.options = contextRequest.options

  let relatedField = uriObject.relatedField
  const relationship = uriObject.relationship

  if (relationship) {
    if (relatedField !== reservedKeys.relationships)
      throw new NotFoundError('Invalid relationship URI.')

    // This is a little unorthodox, but POST and DELETE requests to a
    // relationship entity should be treated as updates.
    if (method === methods.create || method === methods.delete) {
      contextRequest.originalMethod = method
      contextRequest.method = methods.update
    }

    relatedField = relationship
  }

  if (relatedField && inflectKeys)
    relatedField = inflection.camelize(underscore(relatedField), true)

  if (relatedField && (!(relatedField in fields) ||
    !(keys.link in fields[relatedField]) ||
    fields[relatedField][keys.denormalizedInverse]))
    throw new NotFoundError(`The field "${relatedField}" is ` +
      `not a link on the type "${type}".`)

  return relatedField ? adapter.find(type, ids, {
    // We only care about getting the related field.
    fields: { [relatedField]: true }
  }, meta)
  .then(records => {
    // Reduce the related IDs from all of the records into an array of
    // unique IDs.
    const relatedIds = Array.from((records || []).reduce((ids, record) => {
      const value = record[relatedField]

      if (Array.isArray(value)) for (const id of value) ids.add(id)
      else ids.add(value)

      return ids
    }, new Set()))

    const relatedType = fields[relatedField][keys.link]

    // Copy the original type and IDs to temporary keys.
    contextRequest.relatedField = request.meta.relatedField = relatedField
    contextRequest.relationship = request.meta.relationship = relationship
    contextRequest.originalType = request.meta.originalType = type
    contextRequest.originalIds = request.meta.originalIds = ids

    // Write the related info to the request, which should take
    // precedence over the original type and IDs.
    contextRequest.type = request.meta.type = relatedType
    contextRequest.ids = request.meta.ids = relatedIds

    return contextRequest
  }) : contextRequest
}


/**
 * Internal function to map a record to JSON API format. It must be
 * called directly within the context of the serializer. Within this
 * function, IDs must be cast to strings, per the spec.
 */
function mapRecord (type, record) {
  const keys = this.keys
  const uriTemplate = this.uriTemplate
  const recordTypes = this.recordTypes
  const fields = recordTypes[type]
  const options = this.options
  const prefix = options.prefix
  const inflectType = options.inflectType
  const inflectKeys = options.inflectKeys
  const clone = {}

  const id = record[keys.primary]

  clone[reservedKeys.type] = inflectType ?
    inflection.transform(type, typeInflections[1]) : type
  clone[reservedKeys.id] = id.toString()
  clone[reservedKeys.meta] = {}
  clone[reservedKeys.attributes] = {}
  clone[reservedKeys.relationships] = {}
  clone[reservedKeys.links] = {
    [reservedKeys.self]: prefix + uriTemplate.fillFromObject({
      type: inflectType ?
        inflection.transform(type, typeInflections[1]) : type,
      ids: id
    })
  }

  const unionFields = union(Object.keys(fields), Object.keys(record))

  for (let i = 0, j = unionFields.length; i < j; i++) {
    let field = unionFields[i]

    if (field === keys.primary) continue

    const fieldDefinition = fields[field]
    const hasField = field in record

    if (!hasField && !fieldDefinition[keys.link]) continue

    const originalField = field

    // Per the recommendation, dasherize keys.
    if (inflectKeys)
      field = inflection.transform(field,
        [ 'underscore', 'dasherize' ])

    // Handle meta/attributes.
    if (!fieldDefinition || fieldDefinition[keys.type]) {
      const value = record[originalField]

      if (!fieldDefinition) clone[reservedKeys.meta][field] = value
      else clone[reservedKeys.attributes][field] = value

      continue
    }

    // Handle link fields.
    const ids = record[originalField]

    const linkedType = inflectType ?
      inflection.transform(fieldDefinition[keys.link], typeInflections[1]) :
      fieldDefinition[keys.link]

    clone[reservedKeys.relationships][field] = {
      [reservedKeys.links]: {
        [reservedKeys.self]: prefix + uriTemplate.fillFromObject({
          type: inflectType ?
            inflection.transform(type, typeInflections[1]) : type,
          ids: id,
          relatedField: reservedKeys.relationships,
          relationship: inflectKeys ? inflection.transform(field,
            [ 'underscore', 'dasherize' ]) : field
        }),
        [reservedKeys.related]: prefix + uriTemplate.fillFromObject({
          type: inflectType ?
            inflection.transform(type, typeInflections[1]) : type,
          ids: id,
          relatedField: inflectKeys ? inflection.transform(field,
            [ 'underscore', 'dasherize' ]) : field
        })
      }
    }

    if (hasField)
      clone[reservedKeys.relationships][field][reservedKeys.primary] =
        fieldDefinition[keys.isArray] ?
          ids.map(toIdentifier.bind(null, linkedType)) :
          (ids ? toIdentifier(linkedType, ids) : null)
  }

  if (!Object.keys(clone[reservedKeys.attributes]).length)
    delete clone[reservedKeys.attributes]

  if (!Object.keys(clone[reservedKeys.meta]).length)
    delete clone[reservedKeys.meta]

  if (!Object.keys(clone[reservedKeys.relationships]).length)
    delete clone[reservedKeys.relationships]

  return clone
}


function toIdentifier (type, id) {
  return {
    [reservedKeys.type]: type,
    [reservedKeys.id]: id.toString()
  }
}


function attachQueries (request) {
  const recordTypes = this.recordTypes
  const keys = this.keys
  const castValue = this.castValue
  const BadRequestError = this.errors.BadRequestError
  const options = this.options
  const inflectKeys = options.inflectKeys
  const includeLimit = options.includeLimit
  const maxLimit = options.maxLimit
  const type = request.type
  const fields = recordTypes[type]
  const reduceFields = (fields, field) => {
    fields[inflect(field)] = true
    return fields
  }
  const castMap = (type, options, x) => castValue(x, type, options)

  let query = request.uriObject.query
  if (!query) query = {}
  request.options = {}

  // Iterate over dynamic query strings.
  for (const parameter of Object.keys(query)) {
    // Attach fields option.
    if (parameter.match(isField)) {
      const sparseField = Array.isArray(query[parameter]) ?
        query[parameter] : query[parameter].split(',')
      const sparseType = (parameter.match(inBrackets) || [])[1]
      const fields = sparseField.reduce(reduceFields, {})

      if (sparseType === type)
        request.options.fields = fields
    }

    // Attach match option.
    if (parameter.match(isFilter)) {
      const matches = parameter.match(inBrackets) || []
      const field = inflect(matches[1])
      const filterType = matches[2]

      if (!(field in fields)) throw new BadRequestError(
        `The field "${field}" is non-existent.`)

      const fieldType = fields[field][keys.type]

      if (filterType === void 0) {
        if (!('match' in request.options)) request.options.match = {}
        const value = Array.isArray(query[parameter]) ?
          query[parameter] : query[parameter].split(',')
        request.options.match[field] =
          value.map(castMap.bind(null, fieldType, options))
      }
      else if (filterType === 'exists') {
        if (!('exists' in request.options)) request.options.exists = {}
        request.options.exists[field] = bool(query[parameter])
      }
      else if (filterType === 'min' || filterType === 'max') {
        if (!('range' in request.options)) request.options.range = {}
        if (!(field in request.options.range))
          request.options.range[field] = [null, null]
        const index = filterType === 'min' ? 0 : 1
        request.options.range[field][index] =
          castValue(query[parameter], fieldType, options)
      }
      else throw new BadRequestError(
        `The filter "${filterType}" is not valid.`)
    }
  }

  // Attach include option.
  if (reservedKeys.include in query) {
    request.include = (Array.isArray(query[reservedKeys.include]) ?
      query[reservedKeys.include] :
      query[reservedKeys.include].split(','))
      .map(i => i.split('.').map(x => inflect(x)).slice(0, includeLimit))

    // Manually expand nested includes.
    for (const path of request.include)
      for (let i = path.length - 1; i > 0; i--) {
        const j = path.slice(0, i)
        if (!request.include.some(deepEqual.bind(null, j)))
          request.include.push(j)
      }
  }

  // Attach sort option.
  if (reservedKeys.sort in query)
    request.options.sort = (Array.isArray(query.sort) ?
      query.sort : query.sort.split(','))
      .reduce((sort, field) => {
        if (field.charAt(0) === '-') sort[inflect(field.slice(1))] = false
        else sort[inflect(field)] = true
        return sort
      }, {})

  // Attach offset option.
  if (pageOffset in query)
    request.options.offset = Math.abs(parseInt(query[pageOffset], 10))

  // Attach limit option.
  if (pageLimit in query)
    request.options.limit = Math.abs(parseInt(query[pageLimit], 10))

  // Check limit option.
  const limit = request.options.limit
  if (!limit || limit > maxLimit) request.options.limit = maxLimit

  // Internal function to inflect field names.
  function inflect (x) {
    return inflectKeys ? inflection.camelize(underscore(x), true) : x
  }
}


function mapId (relatedType, link) {
  const ConflictError = this.errors.ConflictError

  if (link[reservedKeys.type] !== relatedType)
    throw new ConflictError('Data object field ' +
      `"${reservedKeys.type}" is invalid, it must be ` +
      `"${relatedType}", not "${link[reservedKeys.type]}".`)

  return castId(link[reservedKeys.id])
}


function matchId (object, id) {
  return id === castId(object[reservedKeys.id])
}


function castId (id) {
  // Stolen from jQuery source code:
  // https://api.jquery.com/jQuery.isNumeric/
  const float = Number.parseFloat(id)
  return id - float + 1 >= 0 ? float : id
}


// Due to the inflection library not implementing the underscore feature as
// as expected, it's done here.
function underscore (s) {
  return s.replace(/-/g, '_')
}


function parseBuffer (payload) {
  const BadRequestError = this.errors.BadRequestError

  if (!Buffer.isBuffer(payload)) return payload

  try {
    return JSON.parse(payload.toString())
  }
  catch (error) {
    throw new BadRequestError(`Invalid JSON: ${error.message}`)
  }
}


function union () {
  const result = []
  const seen = {}
  let value
  let array

  for (let g = 0, h = arguments.length; g < h; g++) {
    array = arguments[g]

    for (let i = 0, j = array.length; i < j; i++) {
      value = array[i]
      if (!(value in seen)) {
        seen[value] = true
        result.push(value)
      }
    }
  }

  return result
}


function checkLowerCase (type, recordTypes) {
  const lowerCasedType = type.charAt(0).toLowerCase() + type.slice(1)
  return lowerCasedType in recordTypes ? lowerCasedType : type
}


function bool (value) {
  if (typeof value === 'string')
    return /^(true|t|yes|y|1)$/i.test(value.trim())
  if (typeof value === 'number') return value === 1
  if (typeof value === 'boolean') return value

  return false
}
