package com.radio.listener

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.socket.client.IO
import io.socket.client.Socket

class MainActivity : ComponentActivity() {
    
    // Using Android Emulator localhost fallback
    private val BACKEND_URL = "http://10.0.2.2:3999"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    background = Color(0xFF1C1B1F),
                    surface = Color(0xFF28262C),
                    primary = Color(0xFFFFB300) // Amber
                )
            ) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    ListenerApp(BACKEND_URL)
                }
            }
        }
    }
}

@Composable
fun ListenerApp(backendUrl: String) {
    var isLive by remember { mutableStateOf(false) }
    var isTuned by remember { mutableStateOf(false) }
    var stationName by remember { mutableStateOf("Radio") }
    var listenerCount by remember { mutableStateOf(0) }
    var nowPlayingTitle by remember { mutableStateOf("Waiting for the show") }
    var nowPlayingArtist by remember { mutableStateOf("The host isn't on air right now.") }

    LaunchedEffect(Unit) {
        try {
            val socket = IO.socket(backendUrl)
            socket.connect()
            
            socket.on(Socket.EVENT_CONNECT) {
                socket.emit("listener:join", "android-client-${System.currentTimeMillis()}")
            }
            
            socket.on("station:status") { args ->
                if (args.isNotEmpty() && args[0] != null) {
                    val status = args[0].toString()
                    isLive = status.contains("\"live\":true") || status.contains("live=true")
                }
            }
            
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        // Top Header
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(stationName, fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Color.White)
                Text(if (isLive) "On air" else "Off air", color = if (isLive) Color.Green else Color.Gray)
            }
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(16.dp)
            ) {
                Text(
                    text = "$listenerCount listening",
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    color = Color.White
                )
            }
        }
        
        Spacer(modifier = Modifier.height(24.dp))
        
        // Dial Area
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(nowPlayingTitle, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
                Spacer(modifier = Modifier.height(4.dp))
                Text(nowPlayingArtist, color = Color.LightGray)
            }
        }
        
        Spacer(modifier = Modifier.height(24.dp))
        
        // Tune In Button
        Button(
            onClick = { isTuned = !isTuned },
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (!isTuned) MaterialTheme.colorScheme.primary else Color.DarkGray
            ),
            shape = RoundedCornerShape(12.dp)
        ) {
            Text(if (!isTuned) "▶ Tune in" else "■ Stop listening", color = Color.Black, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        
        Spacer(modifier = Modifier.height(24.dp))
        
        Text("Library & Requests", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = Color.White)
        Spacer(modifier = Modifier.height(8.dp))
        Text("Search and request songs UI will be implemented here.", color = Color.Gray)
    }
}
