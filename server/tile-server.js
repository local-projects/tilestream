// Routes for the tile server. Suitable for HTTP cacheable content with a
// long TTL.
var _ = require('underscore'),
    Step = require('step'),
    fs = require('fs'),
    path = require('path'),
    compress = require('compress'),
    Tile = require('tilelive').Tile,
    errorTile;

function inflate(buffer, callback) {
    var gz = new compress.Gunzip();
    var data = '';
    gz.write(buffer, function(err, chunk) {
        if (err) {
            callback(err);
            callback = undefined;
        }
        else data += chunk;
    });
    gz.close(function(err, chunk) {
        if (err) {
            if (callback) callback(err);
        }
        else data = callback(null, data + chunk);
    });
}

module.exports = function(app, settings) {
    // Load errorTile into memory at require time. Blocking.
    if (!errorTile) {
        errorTile = fs.readFileSync(path.join(__dirname,
            '..',
            'client',
            'images',
            'errortile.png'));
    }

    // Route middleware. Validates an mbtiles file specified in a tile or
    // download route.
    var validateTileset = function(req, res, next) {
        res.mapfile = path.join(settings.tiles, req.params[0] + '.mbtiles');
        path.exists(res.mapfile, function(exists) {
            if (exists) {
                return next();
            } else {
                res.send(errorTile, {
                    'Content-Type':'image/png',
                }, 404);
            }
        });
    };

    // Load HTTP headers specific to the requested mbtiles file.
    var loadMapFileHeaders = function(req, res, next) {
        var headers = {};
        if (res.mapfile) {
            fs.stat(res.mapfile, function(err, stat) {
                if (!err) {
                    res.mapfile_headers = {
                        'Last-Modified': stat.mtime,
                        'E-Tag': stat.size + '-' + Number(stat.mtime)
                    }
                    // res.mapfileStat = stat;
                    return next();
                }
            });
        }
    }

    // If "download" feature is enabled, add route equivalent to
    // `/download/:tileset` except with handling for `:tileset` parameters that may
    // contain a `.` character.
    if (settings.features && settings.features.download) {
        var download = /^\/download\/([\w+|\d+|.|-]*)?.mbtiles/;
        app.get(download, validateTileset, function(req, res, next) {
            res.sendfile(res.mapfile, function(err, path) {
                return err && next(err);
            });
        });
    }

    // Route equivalent to `/1.0.0/:tileset/:z/:x/:y.:format` except with handling
    // for `:tileset` parameters that may contain a `.` character.
    var tile = /^\/1.0.0\/([\w+|\d+|.|-]*)?\/([-]?\d+)\/([-]?\d+)\/([-]?\d+).(png|jpg|jpeg)/;
    app.get(tile, validateTileset, loadMapFileHeaders, function(req, res, next) {
        var tile = new Tile({
            type: 'mbtiles',
            datasource: res.mapfile,
            format: req.params[4],
            xyz: [req.params[2], req.params[3], req.params[1]]
        });
        tile.render(function(err, data) {
            if (!err) {
                res.send(data[0], _.extend({},
                    res.mapfile_headers,
                    settings.header_defaults,
                    data[1]));
            } else {
                res.send(errorTile, {
                    'Content-Type':'image/png',
                }, 404);
            }
        });
    });

    // Load a tileset formatter or legend.
    var formatter = /^\/1.0.0\/([\w+|\d+|.|-]*)?\/(formatter.json|legend.json)/;
    app.get(formatter, validateTileset, loadMapFileHeaders, function(req, res, next) {
        var tile = new Tile({
            type: 'mbtiles',
            datasource: res.mapfile,
            format: req.params[1],
        });
        tile.render(function(err, data) {
            if ((err && err.toString() === 'empty row') || !data) {
                res.send(req.params[1] + ' not found', 404);
            } else if (err) {
                res.send(err.toString(), 500);
            } else {
                var object = {};
                var key = req.params[1].split('.').shift();
                object[key] = data;
                res.send(object, _.extend({
                        'Content-Type': 'text/javascript'
                    },
                    res.mapfile_headers,
                    settings.header_defaults));
            }
        });
    });

    // Load an interaction grid tile.
    var grid = /^\/1.0.0\/([\w+|\d+|.|-]*)?\/([-]?\d+)\/([-]?\d+)\/([-]?\d+).grid.json/;
    app.get(grid, validateTileset, loadMapFileHeaders, function(req, res, next) {
        var tile = new Tile({
            type: 'mbtiles',
            datasource: res.mapfile,
            format: 'grid.json',
            xyz: [req.params[2], req.params[3], req.params[1]]
        });
        Step(
            function() {
                tile.render(this);
            },
            function(err, grid) {
                if (err) {
                    res.send(err.toString(), 500);
                } else if (!grid[0]) {
                    res.send('Grid not found', 404);
                } else {
                    var grid_compressed = grid[0];
                    var grid_data = grid[1];
                    // Data coming out of MBTiles is gzipped;
                    // we need to inflate it to deal with it.
                    inflate(new Buffer(grid_compressed, 'binary'), function(err, grid) {
                        res.writeHead(200, _.extend({
                                'Content-Type': 'text/javascript'
                            },
                            res.mapfile_headers,
                            settings.header_defaults));

                        // Manually wrap the JSON in JSONp in order to
                        // avoid re-encoding the UTF-8 in griddata
                        if (req.query.callback) {
                            res.write(req.query.callback + '({"grid":');
                        }
                        res.write(grid);
                        res.write(',"grid_data":');
                        res.write(JSON.stringify(grid_data));
                        if (req.query.callback) {
                            res.write('});');
                        }
                        res.end();
                    });
                }
            }
        );
    });
};
