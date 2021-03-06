/**
 * gfs-update - a fairly ugly script to download a range of GFS files and deploy extracted layers to AWS S3
 *
 * Example usage: to download products in the range of cycles from the most recent cycle until the cycle 24 hours
 * previous, pulling down the first nine forecasts from the first cycle in the range:
 *
 *     node gfs-update.js -g ../scratch -l ../scratch/data/weather --from recent --back 6 --depth 9
 *
 * To update the set of "current" layers only, do not specify any cycles:
 *
 *     node gfs-update.js -g ../scratch -l ../scratch/data/weather
 */

// TODO: allow extraction and push to S3 to occur right after download rather than waiting for all downloads to finish
// TODO: handle case where two separate process pipelines, from two different runs, may be trying to extract the same
//       layer at once, or push to the S3 at once

"use strict";

var argv = require("optimist")
    .usage("Usage: $0 -g {path} -l {path} -f now|recent|{date} [-u now|{date}] [-b {hours}] [-d {num}]")
    .demand(["g", "l"])
    .alias("g", "gribhome")
        .describe("g", "path where to save downloaded GRIB files")
    .alias("l", "layerhome")
        .describe("l", "path where to save extracted layers")
    .alias("f", "from")
        .describe("f", "begin update from cycle corresponding to this time, going backwards chronologically")
    .alias("u", "until")
        .describe("u", "end update at cycle corresponding to this time")
    .alias("b", "back")
        .describe("b", "end update at cycle going back this many hours from the start")
    .alias("d", "depth")
        .default("d", 1)
        .describe("d", "forecast depth to fetch for first cycle (default depth of '1')")
    .argv;

console.log("============================================================");
console.log(new Date().toISOString() + " - Starting");

var util = require("util");
var fs = require("fs");
var _ = require("underscore");
var mkdirp = require("mkdirp");
var temp = require("temp");
var when = require("when");
var delay = require("when/delay");
var guard = require('when/guard');
var tool = require("./tool");
var gfs = require("./gfs");
var aws = require("./aws");
var scraper = require("./scraper");
var log = tool.log();

temp.track(true);

var INDENT;  // = 2;
var GRIB2JSON_FLAGS = "-c -d -n";
var LAYER_RECIPES = {
    wi10: {
        name: "wind-isobaric-10hPa",
        filter: "--fc 2 --fp wind --fs 100 --fv 1000",
        description: "Wind Velocity @ 10 hPa"
    },
    wi70: {
        name: "wind-isobaric-70hPa",
        filter: "--fc 2 --fp wind --fs 100 --fv 7000",
        description: "Wind Velocity @ 70 hPa"
    },
    wi250: {
        name: "wind-isobaric-250hPa",
        filter: "--fc 2 --fp wind --fs 100 --fv 25000",
        description: "Wind Velocity @ 250 hPa"
    },
    wi500: {
        name: "wind-isobaric-500hPa",
        filter: "--fc 2 --fp wind --fs 100 --fv 50000",
        description: "Wind Velocity @ 500 hPa"
    },
    wi700: {
        name: "wind-isobaric-700hPa",
        filter: "--fc 2 --fp wind --fs 100 --fv 70000",
        description: "Wind Velocity @ 700 hPa"
    },
    wi850: {
        name: "wind-isobaric-850hPa",
        filter: "--fc 2 --fp wind --fs 100 --fv 85000",
        description: "Wind Velocity @ 850 hPa"
    },
    wi1000: {
        name: "wind-isobaric-1000hPa",
        filter: "--fc 2 --fp wind --fs 100 --fv 100000",
        description: "Wind Velocity @ 1000 hPa"
    }
//    ti1000: {
//        name: "temp-isobaric-1000hPa",
//        filter: "--fc 0 --fp 0 --fs 100 --fv 100000",
//        description: "Temperature @ 1000 hPa",
//        stack: [],
//        cross: ["wi1000", "ti1000"]
//    }
};

var servers = [
    gfs.servers.NOMADS,
    gfs.servers.NCEP
];

var opt = function() {

    log.info("arguments: \n" +
        util.inspect(_.pick(argv, "gribhome", "layerhome", "from", "until", "back", "_")));

    var startDate = null, endDate = null, back = null;
    if (argv.from) {
        startDate = argv.from === "now" ?
            new Date() :
            argv.from === "recent" ?
                "recent" :
                new Date(argv.from);

        if (argv.back) {
            back = -argv.back;
            endDate = tool.addHours(startDate, back);
        }
        else {
            endDate = !argv.until ?
                startDate :
                argv.until === "now" ?
                    new Date() :
                    new Date(argv.until);
        }
    }

    var forecasts = [0];
    for (var i = 1; i <= argv.depth; i++) {
        forecasts.push(i * 3);
    }

    return {
        gribHome: tool.ensureTrailing(argv.gribhome, "/"),
        layerHome: tool.ensureTrailing(argv.layerhome, "/"),
        startDate: startDate,
        endDate: endDate,
        back: back,
        firstForecasts: forecasts,
        subsequentForecasts: [0, 3],
        productType: "1.0"
    };
}();

log.info("options: \n" + util.inspect(opt));

mkdirp.sync(opt.gribHome);
mkdirp.sync(opt.layerHome);

function nextServer() {
    if (servers.length === 0) {
        log.error("didn't expect to find 0 servers available");
        return gfs.servers.NOMADS;
    }
    return servers.pop();
}

function releaseServer(server) {
    servers.push(server);
}

/**
 * Returns a promise for a downloaded product. If the product already exists, this method skips
 * the download and returns success. If the download fails, the promise is rejected.
 *
 * @param product
 * @returns {*}
 */
function download(product) {
    // CONSIDER: generalize this function by removing dependency on product object
    var localPath = product.path(opt.gribHome);
    if (fs.existsSync(localPath)) {
        log.info("already exists: " + localPath);
        return when.resolve(product);
    }

    var server = nextServer();
    var remotePath = product.path("http://" + server);
    var tempStream = temp.createWriteStream();
    var progress = 0;
    log.info("GET: " + remotePath);
    return delay(10 * 1000).then(function() {
        return tool.download(remotePath, tempStream).then(
            function(result) {
                releaseServer(server);
                if (result.statusCode >= 300) {
                    log.info(util.format("download failed: %s", util.inspect(result)));
                    return product;
                }
                mkdirp.sync(product.dir(opt.gribHome));
                fs.renameSync(tempStream.path, localPath); // UNDONE: cleanup temp, and don't affect other dls in progress
                var kps = Math.round(result.received / 1024 / result.duration * 1000);
                log.info("download complete: " + kps + "Kps "  + remotePath);
                return product;
            },
            null,
            function(update) {
                var current = Math.floor(update.received / 1024 / 1024);
                if (current > progress) {
                    log.info((progress = current) + "M " + remotePath);
                }
            });
    });
}

var download_throttled = guard(guard.n(servers.length), download);

function createTemp(options) {
    var tempStream = temp.createWriteStream(options), tempPath = tempStream.path;
    tempStream.end();
    return tempPath;
}

function processLayer(layer, path) {
    var data = tool.readJSONSync(path);
    if (data.length === 0) {
        return null;  // no records
    }
    data.forEach(function(record) {
        record.meta = {
//            id: layer.id(),
            date: layer.product.date().toISOString()
//            description: layer.recipe.description + " - GFS " + layer.product.resolution() + "º",
//            center: "US National Weather Service",
//            nav: {
//                previousDay: null, // gfs.layer(),
//                previous: gfs.layer(layer.recipe, layer.product.previous()).id(),
//                next: gfs.layer(layer.recipe, layer.product.next()).id(),
//                nextDay: null // gfs.layer(),
//            }
        };
    });
    return data;
}

function extractLayer(layer) {
    var productPath = layer.product.path(opt.gribHome);
    var layerPath = layer.path(opt.layerHome);

    if (!fs.existsSync(productPath)) {
        log.info("product file not found, skipping: " + productPath);
        return null;
    }

    if (fs.existsSync(layerPath)) {
        var refTime = tool.readJSONSync("./" + layerPath)[0].header.refTime;  // HACK
        if (new Date(refTime) >= layer.product.cycle.date()) {
            log.info("newer layer already exists for: " + layerPath);
            return when.resolve(layer);
        }
        log.info("replacing obsolete layer: " + layerPath);
    }

    var tempPath = createTemp({suffix: ".json"});
    var args = util.format("%s %s -o %s %s", layer.recipe.filter, GRIB2JSON_FLAGS, tempPath, productPath);

    return tool.grib2json(args, process.stdout, process.stderr).then(function(returnCode) {
        if (returnCode !== 0) {
            log.info(util.format("grib2json failed (%s): %s", returnCode, productPath));
            return when.reject(returnCode);  // ?
        }
        log.info("processing: " + layerPath);

        var data = processLayer(layer, tempPath);
        if (!data) {
            log.info("no layer data, skipping: " + layerPath);
            return null;
        }

        mkdirp.sync(layer.dir(opt.layerHome));
        fs.writeFileSync(layerPath, JSON.stringify(data, null, INDENT));
        log.info("successfully built: " + layerPath);
        return layer;
    });
}

var extractLayer_throttled = guard(guard.n(2), extractLayer);

function extractLayers(product) {
    var layers = Object.keys(LAYER_RECIPES).map(function(recipeId) {
        return gfs.layer(LAYER_RECIPES[recipeId], product);
    });
    return when.map(layers, extractLayer_throttled);
}

function pushLayer(layer) {
    if (!layer) {
        return null;  // no layer, so nothing to do
    }
    var layerPath = layer.path(opt.layerHome);
    if (!fs.existsSync(layerPath)) {
        log.info("Layer file not found, skipping: " + layerPath);
        return null;
    }
    var key = layer.path(aws.S3_LAYER_HOME);
    var metadata = {
        "reference-time": layer.product.cycle.date().toISOString()
    };
    function isNewerThan(existing) {
        var refTime = (existing.Metadata || {})["reference-time"];
        return !refTime || new Date(refTime) < layer.product.cycle.date() || layer.isCurrent;
    }
    var cacheControl = gfs.cacheControlFor(layer);
    return aws.uploadFile(layerPath, aws.S3_BUCKET, key, metadata, isNewerThan, cacheControl).then(function(result) {
        log.info(key + ": " + util.inspect(result));
        return true;
    });
}

var pushLayer_throttled = guard(guard.n(8), pushLayer);

function pushLayers(layers) {
    return when.map(layers, pushLayer_throttled);
}

function processCycle(cycle, forecasts) {
    log.info(JSON.stringify(cycle) + " " + forecasts);

    var products = forecasts.map(function(forecastHour) {
        return gfs.product(opt.productType, cycle, forecastHour);
    });
    var downloads = when.map(products, download_throttled);
    var extracted = when.map(downloads, extractLayers);
    var pushed = when.map(extracted, pushLayers);

    return pushed.then(function() {
        log.info("batch complete");
    });
}

function checkProductsExist(url, dir, productType, forecasts) {
    // get the cycle that matches the directory: "gfs.yyyymmddhh"
    var cycle = gfs.cycle(tool.toISOString({
        year: dir.substr(4, 4),
        month: dir.substr(8, 2),
        day: dir.substr(10, 2),
        hour: dir.substr(12, 2)}));

    // build list of files we expect to exist
    var expectedFiles = forecasts.map(function(forecastHour) {
        return gfs.product(productType, cycle, forecastHour).file();
    });

    // fetch contents of the directory then check if all expected files exist
    return scraper.fetch(url + dir).then(function(dom) {
        var allFiles = scraper.extractAttributes("a", "href", dom);
        var actualFiles = _.intersection(expectedFiles, allFiles);
        return actualFiles.length === expectedFiles.length ? cycle : null;
    });
}

function inspectRecentCycles(url, productType, forecasts) {

    // fetch list of directories on the server and check the most recent ones for the products we require
    return when(scraper.fetch(url)).then(function(dom) {
        var dirs = scraper.matchText(/gfs\.\d{10}\/$/, dom).map(function(n) { return n[0]; });
        dirs = _.last(dirs.sort(), 3);  // inspect at most the last three directories, then give up.
        var i = dirs.length;

        return function check() {
            return i > 0 ?
                checkProductsExist(url, dirs[--i], productType, forecasts).then(function(cycle) {
                    return cycle ? cycle : check();
                }) :
                when.reject("cannot find most recent cycle");
        }();
    });
}

function findMostRecent() {
    var server = nextServer();
    return inspectRecentCycles("http://" + server, opt.productType, opt.firstForecasts).ensure(function() {
        releaseServer(server);
    });
}

function processCycles() {
    var result = [];
    if (!opt.startDate) {
        // No start date, so nothing to do.
        return when.resolve(result);
    }
    var findStart = opt.startDate === "recent" ?
        findMostRecent() :
        when(gfs.cycle(opt.startDate));

    return when(findStart).then(function(startCycle) {
        var endCycle = opt.back ?
            gfs.cycle(tool.addHours(startCycle.date(), opt.back)) :
            opt.endDate === opt.startDate ?
                startCycle :
                gfs.cycle(opt.endDate);
        var cycle = startCycle;
        var first = true;

        while (cycle.date().getTime() >= endCycle.date().getTime()) {
            result.push(processCycle(cycle, first ? opt.firstForecasts : opt.subsequentForecasts));
            cycle = cycle.previous();
            first = false;
        }

        return when.all(result);
    });
}

function copyCurrent() {
    // The set of current layers is determined by the current time. Search for the best set of layers
    // available given the current time and upload them to S3 under the "data/weather/current" path.

    var now = Date.now(), threeDaysAgo = now - 3*24*60*60*1000;

    // Start from the next cycle in the future and search backwards until we find the most recent layer.
    var mostRecentLayer = gfs.layer(LAYER_RECIPES.wi1000, gfs.product(opt.productType, gfs.cycle(now).next(), 0));
    while (mostRecentLayer.product.date() > now) {
        mostRecentLayer = mostRecentLayer.previous();
    }

    // Continue search backwards until we find a layer that exists on disk. Might be several hours ago.
    while (!fs.existsSync(mostRecentLayer.path(opt.layerHome))) {
        mostRecentLayer = mostRecentLayer.previous();
        if (mostRecentLayer.product.date() < threeDaysAgo) {
            // Nothing recent exists, so give up.
            return when.reject("No recent layers found.");
        }
    }

    // The layer we found belongs to a cycle/product. Crack it open to find out which one.
    var header = tool.readJSONSync(mostRecentLayer.path("./" + opt.layerHome))[0].header;  // HACK
    var product = gfs.product(opt.productType, gfs.cycle(header.refTime), header.forecastTime);

    // Symlink the layers from the "data/weather/current" directory:
    var layers = Object.keys(LAYER_RECIPES).map(function(recipeId) {
        // create symlink:  current/current-foo-bar.json -> ../2013/11/26/0300-foo-bar.json

        var src = gfs.layer(LAYER_RECIPES[recipeId], product, false);
        var dest = gfs.layer(LAYER_RECIPES[recipeId], product, true);

        mkdirp.sync(dest.dir(opt.layerHome));
        var destPath = dest.path(opt.layerHome);
        if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);  // remove existing file, if any
        }
        var d = when.defer();
        fs.createReadStream(src.path(opt.layerHome)).pipe(fs.createWriteStream(destPath)).on("finish", function() {
            d.resolve(dest);
        });
        return d.promise;
    });

    // Now push to S3.
    return pushLayers(layers);
}

processCycles()
    .then(copyCurrent)
    .otherwise(tool.report)
    .done();
