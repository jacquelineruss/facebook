var _ = require('lodash');
var moment = require('moment');
var Promise = require('bluebird');
var debug = require('debug')('lib:personal');
var nconf = require('nconf');
 
var mongo = require('./mongo');
var utils = require('./utils');

/* TO be moved in an utils file ? */
function personalParm(what, params) {
    var rv = {
        numId: _.parseInt(params.userId),
        skip: _.parseInt(params.skip),
        amount: _.parseInt(params.amount)
    };
    if(_.isNaN(rv.numId) || _.isNaN(rv.skip) || _.isNaN(rv.amount)) {
        debug("Invalid parameter here: [%s] %j", what, params);
        throw new Error("Invalid parameter");
    }

    debug("%s by user %d skip %d amount %d",
        what, rv.numId, rv.skip, rv.amount);

    rv.startD = moment().subtract(rv.skip, 'd');
    rv.endD = moment().subtract(rv.skip, 'd').subtract(rv.amount, 'd');
    return rv;
}

function getTimelines(req) {
    var numId = _.parseInt(req.params.userId);

    if(_.every(numId), !_.isNaN)
        throw new Error("Invalid request");

    debug("%s getTimelines user %d", req.randomUnicode, numId);

    var mongoAggro = {
        _id : "$timelineId",
        impressions: { $sum: 1},
        timings: { $addToSet: '$impressionTime' }
    };

    var publicMatch = { userId: numId, visibility: 'public' };
    var publicCount = { _id : "$timelineId", visible: { $sum: 1}};

    return Promise.all([
        mongo.aggregate(nconf.get('schema').impressions, {
            userId: numId }, mongoAggro),
        mongo.aggregate(nconf.get('schema').impressions,
            publicMatch, publicCount)
        ])
        .then(function(mixed) {
            var dates = _.first(mixed);
            var visib = _.last(mixed);

            return _.map(dates, function(tle) {
                var timelineId = tle['_id'];
                var visible = _.find(visib, {_id: timelineId}).visible;

                var dates = _.reverse(_.map(tle.timings, function(e) { return moment(e); }));

                /* this might be influenced by the server time, hand is better if 
                 * computed client side */
                var x = moment.duration(_.first(dates) - _.last(dates)).humanize();

                return {
                    startTime: (_.first(dates)).format("YYYY-MM-DD"),
                    when: moment.duration( moment() - _.first(dates) ).humanize() + " ago",
                    duration: x,
                    visible: visible,
                    total: tle.impressions,
                    timelineId: timelineId
                }
            });
        })
        .then(function(fixed) {
            return { json: fixed };
        });
};

function getMetadata(req) {

    var timelineId = /^[a-fA-F0-9]+$/.exec(req.params.timelineId);
            
    if(!timelineId)
        throw new Error("Invalid request");

    timelineId = _.first(timelineId);
    debug("%s getMetadata timelineId %d", req.randomUnicode, timelineId);

    return mongo
        .read(nconf.get('schema').htmls, { timelineId: timelineId })
        .then(function(dirtyc) {
            var cleanc = _.map(dirtyc, function(e) {
                e.daysago = moment.duration(moment(t).subtract(1, 'M') - moment()).humanize() + ' ago';
                return _.omit(e, ['html', '_id', 'userId']);
            });
            return { json: cleanc };
        });
};


/* THESE BELOW ACTUALLY USED in realitycheck */
function contribution(req) {

    pp = personalParm("contribution", req.params);
    return mongo
        .aggregate( nconf.get('schema').impressions,
                    { userId: pp.numId, 
                        impressionTime: { "$lt": new Date( pp.startD.toISOString() ) }, 
                        impressionTime: { "$gt": new Date( pp.endD.toISOString() ) }
                    },
                    { _id: {
                        year: { $year: "$impressionTime" },
                        month: { $month: "$impressionTime" },
                        day: { $dayOfMonth: "$impressionTime" },
                        hour: { $hour: "$impressionTime" },
                        minute: { $minute: "$impressionTime" },
                        visibility: "$visibility"
                    }, impressions: { $sum: 1 } })
        .map(function(C) {
            var t = C['_id'];
            return {
                daysago: moment.duration(moment(t).subtract(1, 'M') - moment()).humanize() + ' ago',
                when: moment(t).subtract(1, 'M'),
                visibility: t.visibility,
                impressions: C.impressions
            }
        })
        .then(_.reverse)
        .then(function(contrib) {
            return { json: contrib};
        });
};

function promoted(req) {

    pp = personalParm("promoted", req.params);
    return mongo
        .read( nconf.get('schema').htmls,
                    { userId: pp.numId, 
                        savingTime: { "$lt": new Date( pp.startD.toISOString() ) }, 
                        savingTime: { "$gt": new Date( pp.endD.toISOString() ) }, 
                      promotedTitle: true, type: 'promoted' })
        .map(function(C) {
            return _.omit(C, ['html']);
        })
        .then(_.reverse)
        .then(function(collection) {
            return { json: collection };
        });
};

function heatmap(req) {

    pp = personalParm("activities heatmap", req.params);

    return mongo
        .aggregate( nconf.get('schema').impressions,
                    { userId: pp.numId, 
                        impressionTime: { "$lt": new Date( pp.startD.toISOString() ) }, 
                        impressionTime: { "$gt": new Date( pp.endD.toISOString() ) }
                    },
                    { _id: {
                        year: { $year: "$impressionTime" },
                        month: { $month: "$impressionTime" },
                        day: { $dayOfMonth: "$impressionTime" },
                        hour: { $hour: "$impressionTime" }
                    }, impressions: { $sum: 1 } })
        .map(function(C) {
            var t = C['_id'];
            return {
                /*
                 * > moment({"year":2017,"month":1,"day":23,"hour":16})
                 * moment("2017-02-23T16:00:00.000")
                 * -- month starting since 0, THIS IS SICK!!
                 */
                when: moment(t).subtract(1, 'M').unix() * 1000,
                impressions: C.impressions
            }
        })
        .reduce(function(memo, hourlyentry) {
            if(!pp.skip)
                debug("Last 24H debug: %s → %d", moment(hourlyentry.when), hourlyentry.impressions);
            if(_.isInteger(hourlyentry.when))
                _.set(memo, hourlyentry.when / 1000, hourlyentry.impressions);
            return memo;
        }, {})
        .then(function(heatmapf) {
            return { json: heatmapf };
        });
};

function htmls(req) {

    pp = personalParm("htmls", req.params);
    return mongo
        .readLimit( nconf.get('schema').htmls,
            { userId: pp.numId },
            { savingTime: -1 }, pp.amount, pp.skip)
        .map(function(element) {
            return _.omit(element, ['html', '_id']);
        })
        .then(function(retv) {
            return { 'json': retv };
        });
};

function profile(req) {
    req.params.skip = 0;
    req.params.amount = 0;
    pp = personalParm("profile", req.params);

    return mongo
        .read( nconf.get('schema').supporters, { userId: pp.numId })
        .map(function(element) {
            return _.omit(element, ['userSecret', '_id']);
        })
        .then(function(retv) {
            return { 'json': retv };
        });
};

function csv(req) {
    req.params.skip = 0;
    req.params.amount = 30000;
    pp = personalParm("csv", req.params);

    var forced = req.params.kind  === "feed" ? "feed" : "promoted";

    if(forced === 'feed')
        var keys = [ 'savingTime', 'id', 'type', 'userId', 'impressionOrder',
                     'timelineId', 'publicationTime', 'postId', 'permaLink',
                     'hrefType', 'source', 'text', 'reason' ];
    else
        var keys = [ 'savingTime', 'id', 'type', 'userId', 'impressionOrder',
                     'timelineId', 'title',
                     'postLink', 'linkType', 'ownerName' ];

    return mongo
        .readLimit( nconf.get('schema').htmls, {
            userId: pp.numId,
            postId: { "$exists": true },
            type: forced,
            savingTime: { "$gt": new Date(moment().subtract(30, 'd').toISOString()) }
        }, { }, pp.amount, pp.skip)
        .map(function(element) {
            return _.omit(element, ['html', '_id']);
        })
        .then(function(htmls) {
            var userId = htmls[0].userId;
            var oldest = htmls[0].savingTime;

            return mongo.read( nconf.get('schema').impressions, {
                userId: userId,
                impressionTime: { "$gt": new Date(moment(oldest).subtract(1, 'd').toISOString()) }
            })
            .reduce(function(memo, impression) {
                _.set(memo, impression.htmlId, impression.impressionOrder);
                return memo;
            }, {})
            .then(function(impdict) {
                return _.map(htmls, function(h) {
                    h.impressionOrder = impdict[h.id];
                    return h;
                });
            });
        })
        .tap(function(a) {
            debug("csv, reduction in progress (cap %d) %d entry", pp.amount, _.size(a));
            if(_.size(a) === pp.amount)
                debug("Limit reached!?");
        })
        .reduce(function(memo, entry) {
            if(!memo.init) {
                memo.csv += _.trim(JSON.stringify(keys), "][") + "\n";
                memo.init = true;
            }
            entry.savingTime = moment(entry.savingTime).toISOString();
            /* TODO check `memo.onlyValue` directive */
            _.each(keys, function(k, i) {
                var swap;
                if(k === 'publicationTime') {
                    swap = _.get(entry, 'publicationUTime');
                    swap = moment(swap * 1000).toISOString();
                } else {
                    swap = _.get(entry, k, "");
                    swap = _.replace(swap, /\"/g, '〃');
                    swap = _.replace(swap, /\'/g, '’');
                }
                memo.csv +=  '"' + swap + '"';
                if(!_.eq(i, _.size(keys) - 1))
                    memo.csv += ',';
            });
            memo.csv += "\n";
            return memo;

        }, { init: false, onlyValues: false, csv: "" })
        .then(function(blob) {
            var t = blob.csv;
            debug("csv long %d entries", _.size(t));
            return {
                headers: { "Content-Type": "csv/text",
                           "content-disposition":
                               "attachment; filename=\"" + forced + "-" + pp.numId + ".csv\""
                },
                text: t
            };
        });
};


module.exports = {
    getTimelines: getTimelines,
    getMetadata: getMetadata,

    contribution: contribution,
    promoted: promoted,
    heatmap: heatmap,
    htmls: htmls,
    profile: profile,
    csv: csv
};
