# Chupacabra

Chupacabra is a lightweight Node.js application with web browser interface for discovery and monitoring network devices.<br>
Supported protocols: ICMP (ping), SNMP v1/2c/3, Modbus TCP, IPMI, WMI and http/s.<br>
Also you can polling [**Zabbix**](http://www.zabbix.com/download), [**Check-mk**](https://mathias-kettner.de/checkmk_linuxagent.html) and [**Munin**](https://github.com/munin-monitoring/munin-c) agents and check TCP/UDP ports.

Cross-platform, open source, extendable, free.

# Features
* Polling device by any supported protocols
* Check threshold values 
* Auto-dashboard based on tags
* Calculated and temporary varbinds
* Online statuses and charts on device page
* Templates to create copy in one click
* Extreme compact storage of history data (2-4Byte per numeric value)
* Flexible mechanism of alert messages
* Alert management
* Notify on new device in network
* and MORE!

Roadmap
* Distributed
* Support for polling VMs, JVM, etc
* Daily data aggregation
* Real-time dashboard

Try [**demo**](http://77.37.160.20:5000/). Remote user has read-only access.<br>
Visit [**Wiki**](https://github.com/little-brother/chupacabra/wiki) to learn more.<br>

![Screenshots](http://little-brother.ru/images/chupacabra3.gif)<br>

## Requirements
* [**Node.js**](https://nodejs.org/en/download/) (JavaScript runtime engine)
* [**nmap**](https://nmap.org/download.html) (network scanner)

Optional
* WMI: [**wmic**](https://www.krenger.ch/blog/wmi-commands-from-linux/)
* SNMPv3: [**Net-SNMP**](http://www.net-snmp.org/)
* IPMI: [**IPMItool**](https://sourceforge.net/projects/ipmitool/)

## Installation
1. [**Download and unpack**](https://github.com/little-brother/chupacabra/archive/master.zip) or run
   ```
   git clone --depth=1 https://github.com/little-brother/chupacabra.git
   ``` 
2. Run to install dependencies
   ```
   npm i
   ```
3. Run Chupacabra
   ```
   node app
   ```
4. Go to browser and open url `http://127.0.0.1:5000`

## Usage
1. Set value type of varbind as number to view history on chart.
2. If value type of varbind is a number then log each values into `history.sqlite` file.<br> 
   Otherwise log only changes into `changes.sqlite`.	
3. Set up device and push &#128190; to save varbind list as template.<br>
   Template will be appear in "Add device"-menu and in scan results.
4. Read expression protocol help to learn about its power.
5. Start varbind name from `$` to create temporary (unlogged and hidden) varbind.
6. Use `http://127.0.0.1:5000/stats` to get summary details.

## Configuration (config.json)
* **port** - http-server port. By default `5000`. Next port number will be use to realtime update interface via websocket.

* **access** - define access by ips.
  * **edit** (array) - allowed edit from those ips. By default is `["127.0.0.1", "::ffff:127.0.0.1", "localhost"]`.
  * **view** (array) - allowed view from those ips. By default is `any`. 
  
* **ping-period** - in seconds. By default `300`.

* **db** - sqlite configuration on start up. By default is `{'synchronous': 0}`. See details in [Wiki](https://github.com/little-brother/chupacabra/wiki/English).

* **publisher** - send data to external server e.g. [`Graphite`](https://graphiteapp.org/) or publish on local tcp-port.
  * **host** - server host. If host is not set then application open local tcp-port and publish data to it.
  * **port** - by default `2003`. Or `5002` if host is empty.	
  * **pattern** - output row pattern. By default `${device.name}/{varbind.name} ${varbind.value} $time`.
  * **delimiter** - row delimiter. By default is `\r\n`
  * **only-numeric** - publish only `numeric` varbinds. By default `false`.	

* **alerters** - set of alerter. Each alerter has next params
  * **event** - one of `on-change`, `on-normal`, `on-warning`, `on-critical`.<br>
  * **command** - any shell command. You can use `${device.*}` and `${reason}`.
  * **options** - special command [options](https://nodejs.org/api/child_process.html#child_process_child_process_exec_command_options_callback). By default `{}`.	
  * **active** - the time when messages are sent in [Zabbix time periods format](https://www.zabbix.com/documentation/3.0/manual/appendix/time_period). By default is `empty` (any time).
  * **tags** - array of optional tags.
  
  See details in [Wiki](https://github.com/little-brother/chupacabra/wiki/English).
 
* **catchers** - set of event catcher. Each catcher is daemon, eg `snmptrapd`, who catch incoming message.<br>
  Application parse daemon log, extract sender ip by pattern and force device polling with this ip.
  * **command** - the command to run.
  * **args** - list of string arguments.
  * **options** - optional [options](https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options) for command.
  * **pattern** - regexp pattern to get ip address.
    
  See details in [Wiki](https://github.com/little-brother/chupacabra/wiki/English).

* **auto-scan** - define params of process to check network on new devices. If `on-detect` is not set then auto-scan is off.
  * **period** - in seconds. By default `600`.
  * **range** - use nmap range format e.g. `192.168.0.1-255`. Already registered IP will be ignored.
  *	**on-detect** - shell command executed for each unknown devices. You can use `${ip}`, `${mac}` and `${description}`.