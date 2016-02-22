# Fortune JSON API Serializer

[![Build Status](https://img.shields.io/travis/fortunejs/fortune-json-api/master.svg?style=flat-square)](https://travis-ci.org/fortunejs/fortune-json-api)
[![npm Version](https://img.shields.io/npm/v/fortune-json-api.svg?style=flat-square)](https://www.npmjs.com/package/fortune)
[![License](https://img.shields.io/npm/l/fortune-json-api.svg?style=flat-square)](https://raw.githubusercontent.com/fortunejs/fortune-json-api/master/LICENSE)

This is a [JSON API](http://jsonapi.org) serializer for [Fortune.js](http://fortunejs.com), which implements all of the features in the [base specification](http://jsonapi.org/format/), and follows the [recommendations](http://jsonapi.org/recommendations/) as much as possible. It is tested against Fortune.js version `3.x`.

```sh
$ npm install fortune-json-api
```


## Usage

```js
const http = require('http')
const fortune = require('fortune')
const jsonApiSerializer = require('fortune-json-api')

// `instance` is an instance of Fortune.js.
const listener = fortune.net.http(instance, {
  serializers: [
    // The `options` object here is optional.
    [ jsonApiSerializer, options ]
  ]
})
// The listener function may be used as a standalone server, or
// may be composed as part of a framework.
const server = http.createServer(listener)

server.listen(8080)
```

The `options` object is as follows:

- `prefix`: hyperlink prefix, without trailing slash. Default: `""` (empty string).
- `inflectType`: pluralize the record type name in the URI. Default: `true`.
- `inflectKeys`: camelize the field names per record. Default: `true`.
- `maxLimit`: maximum number of records to show per page. Default: `1000`.
- `includeLimit`: maximum depth of fields per include. Default: `3`.
- `bufferEncoding`: which encoding type to use for input buffer fields. Default: `base64`.
- `jsonSpaces`: how many spaces to use for pretty printing JSON. Default: `2`.

Internal options:

- `uriTemplate`: URI template string.
- `allowLevel`: HTTP methods to allow ordered by appearance in URI template.


## License

This software is licensed under the [MIT license](https://raw.githubusercontent.com/fortunejs/fortune-json-api/master/LICENSE).
