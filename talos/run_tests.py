#!/usr/bin/env python

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import mozversion
import mozfile
import logging
import filter
import os
import sys
import time
import traceback
import urllib
import urlparse
import utils

from results import TalosResults
from ttest import TTest
from utils import TalosError, TalosCrash, TalosRegression
from config import get_configs, ConfigurationError

# directory of this file
here = os.path.dirname(os.path.realpath(__file__))


def useBaseTestDefaults(base, tests):
    for test in tests:
        for item in base:
            if item not in test:
                test[item] = base[item]
                if test[item] is None:
                    test[item] = ''
    return tests


def buildCommandLine(test):
    """build firefox command line options for tp tests"""

    # sanity check pageloader values
    # mandatory options: tpmanifest, tpcycles
    if test['tpcycles'] not in range(1, 1000):
        raise TalosError('pageloader cycles must be int 1 to 1,000')
    if test.get('tpdelay') and test['tpdelay'] not in range(1, 10000):
        raise TalosError('pageloader delay must be int 1 to 10,000')
    if 'tpmanifest' not in test:
        raise TalosError("tpmanifest not found in test: %s" % test)

    # build pageloader command from options
    url = ['-tp', test['tpmanifest']]
    CLI_bool_options = ['tpchrome', 'tpmozafterpaint', 'tpdisable_e10s',
                        'tpnoisy', 'rss', 'tprender', 'tploadnocache',
                        'tpscrolltest']
    CLI_options = ['tpcycles', 'tppagecycles', 'tpdelay', 'tptimeout']
    for key in CLI_bool_options:
        if test.get(key):
            url.append('-%s' % key)
    for key in CLI_options:
        value = test.get(key)
        if value:
            url.extend(['-%s' % key, str(value)])

    # XXX we should actually return the list but since we abuse
    # the url as a command line flag to pass to firefox all over the place
    # will just make a string for now
    return ' '.join(url)


def print_logcat():
    if os.path.exists('logcat.log'):
        with open('logcat.log') as f:
            data = f.read()
        for l in data.split('\r'):
            # Buildbot will mark the job as failed if it finds 'ERROR'.
            print l.replace('RROR', 'RR_R')


def setup_webserver(webserver):
    """use mozhttpd to setup a webserver"""

    scheme = "http://"
    if (webserver.startswith('http://') or
        webserver.startswith('chrome://') or
        webserver.startswith('file:///')):  # noqa

        scheme = ""
    elif '://' in webserver:
        print "Unable to parse user defined webserver: '%s'" % (webserver)
        sys.exit(2)

    url = urlparse.urlparse('%s%s' % (scheme, webserver))
    port = url.port

    if port:
        import mozhttpd
        return mozhttpd.MozHttpd(host=url.hostname, port=int(port),
                                 docroot=here)
    else:
        print ("WARNING: unable to start web server without custom port"
               " configured")
        return None


def run_tests(config, browser_config):
    """Runs the talos tests on the given configuration and generates a report.
    """
    # data filters
    filters = config['filters']
    try:
        filters = filter.filters_args(filters)
    except AssertionError, e:
        raise TalosError(str(e))

    # get the test data
    tests = config['tests']
    tests = useBaseTestDefaults(config.get('basetest', {}), tests)

    paths = ['profile_path', 'tpmanifest', 'extensions', 'setup', 'cleanup']
    for test in tests:

        # Check for profile_path, tpmanifest and interpolate based on Talos
        # root https://bugzilla.mozilla.org/show_bug.cgi?id=727711
        # Build command line from config
        for path in paths:
            if test.get(path):
                test[path] = utils.interpolate(test[path])
        if test.get('tpmanifest'):
            test['tpmanifest'] = \
                os.path.normpath('file:/%s' % (urllib.quote(test['tpmanifest'],
                                               '/\\t:\\')))
        if not test.get('url'):
            # build 'url' for tptest
            test['url'] = buildCommandLine(test)
        test['url'] = utils.interpolate(test['url'])
        test['setup'] = utils.interpolate(test['setup'])
        test['cleanup'] = utils.interpolate(test['cleanup'])

        # ensure test-specific filters are valid
        if 'filters' in test:
            try:
                filter.filters_args(test['filters'])
            except AssertionError, e:
                raise TalosError(str(e))
            except IndexError, e:
                raise TalosError(str(e))

    # pass --no-remote to firefox launch, if --develop is specified
    if browser_config['develop']:
        browser_config['extra_args'] = '--no-remote'

    # set defaults
    title = config.get('title', '')
    testdate = config.get('testdate', '')

    if browser_config['e10s'] and not title.endswith(".e"):
        # we are running in e10s mode
        title = "%s.e" % (title,)

    # get the process name from the path to the browser
    if not browser_config['process']:
        browser_config['process'] = \
            os.path.basename(browser_config['browser_path'])

    # fix paths to substitute
    # `os.path.dirname(os.path.abspath(__file__))` for ${talos}
    # https://bugzilla.mozilla.org/show_bug.cgi?id=705809
    browser_config['extensions'] = [utils.interpolate(i)
                                    for i in browser_config['extensions']]
    browser_config['bcontroller_config'] = \
        utils.interpolate(browser_config['bcontroller_config'])

    # normalize browser path to work across platforms
    browser_config['browser_path'] = \
        os.path.normpath(browser_config['browser_path'])

    binary = browser_config.get("apk_path")
    if not binary:
        binary = browser_config["browser_path"]
    version_info = mozversion.get_version(binary=binary)
    browser_config['browser_name'] = version_info['application_name']
    browser_config['browser_version'] = version_info['application_version']
    browser_config['buildid'] = version_info['application_buildid']
    try:
        browser_config['repository'] = version_info['application_repository']
        browser_config['sourcestamp'] = version_info['application_changeset']
    except KeyError:
        if not browser_config['develop']:
            print "unable to find changeset or repository: %s" % version_info
            sys.exit()
        else:
            browser_config['repository'] = 'develop'
            browser_config['sourcestamp'] = 'develop'

    # get test date in seconds since epoch
    if testdate:
        date = int(time.mktime(time.strptime(testdate,
                                             '%a, %d %b %Y %H:%M:%S GMT')))
    else:
        date = int(time.time())
    logging.debug("using testdate: %d", date)
    logging.debug("actual date: %d", int(time.time()))

    # results container
    talos_results = TalosResults(title=title,
                                 date=date,
                                 browser_config=browser_config,
                                 filters=filters)

    # results links
    if not browser_config['develop']:
        results_urls = dict(
            # hardcoded, this will be removed soon anyway.
            results_urls=['http://graphs.mozilla.org/server/collect.cgi'],
            # another hack; datazilla stands for Perfherder
            # and do not require url, but a non empty dict is required...
            datazilla_urls=['local.json'],
        )
    else:
        # local mode, output to files
        results_urls = dict(
            results_urls=[os.path.abspath('local.out')],
            datazilla_urls=[os.path.abspath('local.json')]
        )
    talos_results.check_output_formats(results_urls)

    # setup a webserver, if --develop is specified
    httpd = None
    if browser_config['develop']:
        httpd = setup_webserver(browser_config['webserver'])
        if httpd:
            httpd.start()

    # run the tests
    timer = utils.Timer()
    utils.stamped_msg(title, "Started")
    for test in tests:
        testname = test['name']
        test['browser_log'] = browser_config['browser_log']
        utils.stamped_msg("Running test " + testname, "Started")

        mozfile.remove('logcat.log')

        try:
            mytest = TTest()
            if mytest:
                talos_results.add(mytest.runTest(browser_config, test))
            else:
                utils.stamped_msg("Error found while running %s" % testname,
                                  "Error")
        except TalosRegression:
            utils.stamped_msg("Detected a regression for " + testname,
                              "Stopped")
            print_logcat()
            if httpd:
                httpd.stop()
            # by returning 1, we report an orange to buildbot
            # http://docs.buildbot.net/latest/developer/results.html
            return 1
        except (TalosCrash, TalosError):
            # NOTE: if we get into this condition, talos has an internal
            # problem and cannot continue
            #       this will prevent future tests from running
            utils.stamped_msg("Failed %s" % testname, "Stopped")
            TalosError_tb = sys.exc_info()
            traceback.print_exception(*TalosError_tb)
            print_logcat()
            if httpd:
                httpd.stop()
            # indicate a failure to buildbot, turn the job red
            return 2

        utils.stamped_msg("Completed test " + testname, "Stopped")
        print_logcat()

    elapsed = timer.elapsed()
    print "cycle time: " + elapsed
    utils.stamped_msg(title, "Stopped")

    # stop the webserver if running
    if httpd:
        httpd.stop()

    # output results
    if results_urls:
        talos_results.output(results_urls)
        if browser_config['develop']:
            print ("Thanks for running Talos locally. Results are in"
                   " %s and %s" % (results_urls['results_urls'],
                                   results_urls['datazilla_urls']))

    # we will stop running tests on a failed test, or we will return 0 for
    # green
    return 0


def main(args=sys.argv[1:]):
    try:
        config, browser_config = get_configs()
    except ConfigurationError, exc:
        sys.exit("ERROR: %s" % exc)
    utils.startLogger('debug' if config['debug'] else 'info')
    sys.exit(run_tests(config, browser_config))


if __name__ == '__main__':
    main()
