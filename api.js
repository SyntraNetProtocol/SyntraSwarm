const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5501;

// Configure CORS to allow all origins
app.use(cors());

// Middleware to parse JSON bodies
app.use(express.json());

// Function to get the name of the pod by label
function getPodName(callback) {
    exec("kubectl get pods -l app=debian -n syntracloud -o jsonpath='{.items[0].metadata.name}'", (error, stdout, stderr) => {
        if (error) {
            console.error(`Error fetching pod name: ${error}`);
            return callback(error, null);
        }
        console.log('stdout from getPodName:', stdout);
        console.log('stderr from getPodName:', stderr);
        callback(null, stdout.trim());
    });
}

// Function to send command to the server
function sendCommand(command, res) {
    getPodName((err, podName) => {
        if (err) {
            console.error(`Error in getPodName callback: ${err.message}`);
            return res.status(500).send({ output: `Failed to fetch pod name: ${err.message}` });
        }
        console.log('Pod name:', podName);
        const fullCommand = `kubectl exec ${podName} -n syntracloud -- /bin/bash -c "${command}"`;
        exec(fullCommand, (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`);
                return res.status(500).send({ output: `Error: ${error.message}` });
            }
            console.log('stdout from exec:', stdout);
            console.log('stderr from exec:', stderr);
            if (stderr) {
                console.error(`stderr: ${stderr}`);
                return res.send({ output: stderr });
            }
            res.send({ output: stdout });
        });
    });
}

// POST endpoint to process data and execute commands in Kubernetes pod
app.post('/api/data', (req, res) => {
    const input = req.body.input.trim(); // Remove leading and trailing spaces from the input
    console.log('Input:', input);
    
    // If the input is empty, return an error
    if (!input) {
        return res.status(400).send({ output: 'Input cannot be empty.' });
    }

    // Send the command
    sendCommand(input, res);
});

// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    
    // Execute the function to get the pod name when the server starts
    getPodName((err, podName) => {
        if (err) {
            console.error(`Error fetching pod name on server start: ${err.message}`);
            return;
        }
        console.log('Pod name on server start:', podName);
    });
});
