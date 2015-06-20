(function (exports) {
    "use strict";

    var glutils = exports.glutils = {};
    (function () {
        glutils.createContext = function (canvas, antialias) {
            var attributes = {
                antialias: !!antialias
            };
            var context = canvas.getContext("webgl", attributes);
            if (!context) throw new Error("Unable to initialize WebGL");
            return context;
        };

        glutils.loadResource = function (url, type, ready) {
            type = type || "binary";
            if (type == "image") {
                console.log("loading resource " + url + " as image");
                var img = new Image();
                img.onerror = function (err) {
                    ready(new Error('Resource loading error: Image error. URL:' + url, err), null);
                };
                img.onload = function() {
                    ready(null, img);
                    delete img.onload;
                };
                img.src = url;
            } else {
                var text = type == "text";
                console.log("loading resource " + url + (text ? " as text" : " as binary"));
                var request = new XMLHttpRequest();
                request.open("GET", url, true);
                request.responseType = text ? "text" : "arraybuffer";
                request.onload = function() {
                    ready(null, request.response);
                };
                request.onerror = function() {
                    ready(new Error('Resource loading error: XHR error. URL:' + url), null);
                };
                request.send();
            }
        };

        glutils.createShaderFromScript = function (gl, id) {
            var el = document.getElementById(id);
            var source = el.textContent;
            var type = el.type.match(/x-fragment/) ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER;
            return glutils.createShader(gl, source, type);
        };

        glutils.createShader = function (gl, source, type) {
            var shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error("An error occurred compiling shader " + shaderId
                + ": " + gl.getShaderInfoLog(shader));
            }
            return shader;
        };

        glutils.createProgram = function (gl, shaders) {
            var prog = gl.createProgram();
            shaders.forEach(function (shader) {
                gl.attachShader(prog, shader);
            });
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                throw new Error("Linker failed on program " + prog);
            }
            return prog;
        };
    })();

    var glm = exports.glm = {};
    (function () {
        glm.mat4 = {};
        glm.mat4.allocate = function () { return new Float32Array(4 * 4); };
        glm.mat4.identity = function (m) {
            m[0 ] = 1; m[1 ] = 0; m[2 ] = 0; m[3 ] = 0;
            m[4 ] = 0; m[5 ] = 1; m[6 ] = 0; m[7 ] = 0;
            m[8 ] = 0; m[9 ] = 0; m[10] = 1; m[11] = 0;
            m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
        };
        glm.mat4.multiply = function (out, a, b) {
            var a00 = a[0 ], a01 = a[1 ], a02 = a[2 ], a03 = a[3],
                a10 = a[4 ], a11 = a[5 ], a12 = a[6 ], a13 = a[7],
                a20 = a[8 ], a21 = a[9 ], a22 = a[10], a23 = a[11],
                a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
            var b00 = b[0 ], b01 = b[1 ], b02 = b[2 ], b03 = b[3 ],
                b10 = b[4 ], b11 = b[5 ], b12 = b[6 ], b13 = b[7 ],
                b20 = b[8 ], b21 = b[9 ], b22 = b[10], b23 = b[11],
                b30 = b[12], b31 = b[13], b32 = b[14], b33 = b[15];

            out[0] = b00*a00 + b01*a10 + b02*a20 + b03*a30;
            out[1] = b00*a01 + b01*a11 + b02*a21 + b03*a31;
            out[2] = b00*a02 + b01*a12 + b02*a22 + b03*a32;
            out[3] = b00*a03 + b01*a13 + b02*a23 + b03*a33;

            out[4] = b10*a00 + b11*a10 + b12*a20 + b13*a30;
            out[5] = b10*a01 + b11*a11 + b12*a21 + b13*a31;
            out[6] = b10*a02 + b11*a12 + b12*a22 + b13*a32;
            out[7] = b10*a03 + b11*a13 + b12*a23 + b13*a33;

            out[8 ] = b20*a00 + b21*a10 + b22*a20 + b23*a30;
            out[9 ] = b20*a01 + b21*a11 + b22*a21 + b23*a31;
            out[10] = b20*a02 + b21*a12 + b22*a22 + b23*a32;
            out[11] = b20*a03 + b21*a13 + b22*a23 + b23*a33;

            out[12] = b30*a00 + b31*a10 + b32*a20 + b33*a30;
            out[13] = b30*a01 + b31*a11 + b32*a21 + b33*a31;
            out[14] = b30*a02 + b31*a12 + b32*a22 + b33*a32;
            out[15] = b30*a03 + b31*a13 + b32*a23 + b33*a33;
        };
        glm.mat4.ortho = function (out, left, right, bottom, top, near, far) {
            var lr = 1 / (left - right),
                bt = 1 / (bottom - top),
                nf = 1 / (near - far);
            out[0] = 2 / (right - left);
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            out[4] = 0;
            out[5] = 2 / (top - bottom);
            out[6] = 0;
            out[7] = 0;
            out[8] = 0;
            out[9] = 0;
            out[10] = -2 / (far - near);
            out[11] = 0;
            out[12] = -(right + left) / (right - left);
            out[13] = -(top + bottom) / (top - bottom);
            out[14] = (far + near) / (far - near);
            out[15] = 1;
            return out;
        };
    })();
})(window);
