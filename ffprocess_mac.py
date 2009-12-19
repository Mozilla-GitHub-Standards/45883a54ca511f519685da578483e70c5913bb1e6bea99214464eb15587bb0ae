# ***** BEGIN LICENSE BLOCK *****
# Version: MPL 1.1/GPL 2.0/LGPL 2.1
#
# The contents of this file are subject to the Mozilla Public License Version
# 1.1 (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.mozilla.org/MPL/
#
# Software distributed under the License is distributed on an "AS IS" basis,
# WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
# for the specific language governing rights and limitations under the
# License.
#
# The Original Code is standalone Firefox Mac performance test.
#
# The Initial Developer of the Original Code is Google Inc.
# Portions created by the Initial Developer are Copyright (C) 2006
# the Initial Developer. All Rights Reserved.
#
# Contributor(s):
#   Annie Sullivan <annie.sullivan@gmail.com> (original author)
#   Ben Hearsum    <bhearsum@wittydomain.com> (OS independence)
#   Zach Lipton   <zach@zachlipton.com> (Mac port)
#
# Alternatively, the contents of this file may be used under the terms of
# either the GNU General Public License Version 2 or later (the "GPL"), or
# the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
# in which case the provisions of the GPL or the LGPL are applicable instead
# of those above. If you wish to allow use of your version of this file only
# under the terms of either the GPL or the LGPL, and not to allow others to
# use your version of this file under the terms of the MPL, indicate your
# decision by deleting the provisions above and replace them with the notice
# and other provisions required by the GPL or the LGPL. If you do not delete
# the provisions above, a recipient may use your version of this file under
# the terms of any one of the MPL, the GPL or the LGPL.
#
# ***** END LICENSE BLOCK *****

import subprocess
#HACK - http://www.gossamer-threads.com/lists/python/bugs/593800
#To stop non-threadsafe popen nonsense, should be removed when we upgrade to 
#python 2.5 or later
subprocess._cleanup = lambda: None 
import signal
import os
import time
from select import select
from ffprocess import FFProcess

class MacProcess(FFProcess):

    def __init__(self):
        pass

    def GenerateBrowserCommandLine(self, browser_path, extra_args, profile_dir, url):
        """Generates the command line for a process to run Browser

        Args:
            browser_path: String containing the path to the browser binary to use
            profile_dir: String containing the directory of the profile to run Browser in
            url: String containing url to start with.
        """

        profile_arg = ''
        if profile_dir:
            profile_arg = '-profile %s' % profile_dir

        cmd = '%s -foreground %s %s %s' % (browser_path,
                            extra_args,
                            profile_arg,
                            url)
        return cmd


    def GetPidsByName(self, process_name):
        """Searches for processes containing a given string.

        Args:
            process_name: The string to be searched for

        Returns:
            A list of PIDs containing the string. An empty list is returned if none are
            found.
        """

        matchingPids = []
  
        command = ['ps -Acj']
        handle = subprocess.Popen(command, stdout=subprocess.PIPE, universal_newlines=True, shell=True)
  
        # wait for the process to terminate
        handle.wait()
        data = handle.stdout.readlines()
  
        # find all matching processes and add them to the list
        for line in data:
            #overlook the mac crashreporter daemon
            if line.find("crashreporterd") >= 0:
                continue
            if line.find('defunct') != -1:
                continue
            #overlook zombie processes
            if line.find("Z+") >= 0:
                continue
            if line.find(process_name) >= 0:
                # splits by whitespace, the first one should be the pid
                pid = int(line.split()[1])
                matchingPids.append(pid)

        return matchingPids


    def ProcessesWithNameExist(self, *process_names):
        """Returns true if there are any processes running with the
            given name.  Useful to check whether a Browser process is still running

        Args:
            process_names: String or strings containing the process name, i.e. "firefox"

        Returns:
            True if any processes with that name are running, False otherwise.
        """
        for process_name in process_names:
            pids = self.GetPidsByName(process_name)
            if len(pids) > 0:
                return True
        return False


    def TerminateProcess(self, pid, timeout):
        """Helper function to terminate a process, given the pid

        Args:
            pid: integer process id of the process to terminate.
        """
        try:
            if self.ProcessesWithNameExist(str(pid)):
                os.kill(pid, signal.SIGTERM)
                time.sleep(timeout)
            if self.ProcessesWithNameExist(str(pid)):
                    os.kill(pid, signal.SIGKILL)
        except OSError, (errno, strerror):
            print 'WARNING: failed os.kill: %s : %s' % (errno, strerror)

    def TerminateAllProcesses(self, timeout, *process_names):
        """Helper function to terminate all processes with the given process name

        Args:
            process_names: String or strings containing the process name, i.e. "firefox"
        """
        for process_name in process_names:
            pids = self.GetPidsByName(process_name)
            for pid in pids:
                self.TerminateProcess(pid, timeout)

    def NonBlockingReadProcessOutput(self, handle):
        """Does a non-blocking read from the output of the process
            with the given handle.

        Args:
            handle: The process handle returned from os.popen()

        Returns:
            A tuple (bytes, output) containing the number of output
            bytes read, and the actual output.
        """

        output = ""
        num_avail = 0

        # check for data
        # select() does not seem to work well with pipes.
        # after data is available once it *always* thinks there is data available
        # readline() will continue to return an empty string however
        # so we can use this behavior to work around the problem
        while select([handle], [], [], 0)[0]:
            line = handle.readline()
            if line:
                output += line
            else:
                break
            # this statement is true for encodings that have 1byte/char
            num_avail = len(output)

        return (num_avail, output)
        
    def MakeDirectoryContentsWritable(self, dirname):
        """Recursively makes all the contents of a directory writable.
            Uses os.chmod(filename, 0755).

        Args:
            dirname: Name of the directory to make contents writable.
        """
        try:
            for (root, dirs, files) in os.walk(dirname):
                os.chmod(root, 0755)
                for filename in files:
                    try:
                        os.chmod(os.path.join(root, filename), 0755)
                    except OSError, (errno, strerror):
                        print 'WARNING: failed to os.chmod(%s): %s : %s' % (os.path.join(root, filename), errno, strerror)
        except OSError, (errno, strerror):
            print 'WARNING: failed to MakeDirectoryContentsWritable: %s : %s' % (errno, strerror)

