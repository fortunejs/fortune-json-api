'use strict'

module.exports = function ( name ) {
    const key = {
        'Error': '500' ,
        'UnprocessableError': '422' ,
        'UnsupportedError': '415' ,
        'ConflictError': '409' ,
        'NotAcceptableError': '406' ,
        'MethodError': '405' ,
        'NotFoundError': '404' ,
        'ForbiddenError': '403' ,
        'UnauthorizedError': '401' ,
        'BadRequestError': '400' ,
        'Empty': '204' ,
        'Created': '201' ,
        'OK': '200' 
    }
    return key[name];
}
